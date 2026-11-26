import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import type { CommandResult, WorkerRequest } from './contracts.ts'
import { digest, inventory, snapshotHash } from './paths.ts'
import { createWorkspace, hasSkippedTests, installedNodeModules } from './project.ts'
import { workerAbortSignal } from './sandbox.ts'
import { atomicJson } from './state.ts'
import {
  effectiveExecution,
  isolationUnavailable,
  linkLockedDependencies,
  runWorkerCommand,
  type ExecutionPolicy,
} from './worker-execution.ts'

export const verificationLoopSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal('seeded'),
      Type.Literal('differential'),
      Type.Literal('benchmark'),
    ]),
    argv: Type.Array(Type.String({ maxLength: 4000 }), { minItems: 1, maxItems: 64 }),
    firstSeed: Type.Integer({ minimum: 0, maximum: 4294967295 }),
    count: Type.Integer({ minimum: 1, maximum: 128 }),
    metric: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
  },
  { additionalProperties: false },
)
type Input = Static<typeof verificationLoopSchema>
type Snapshot = { root: string; files: Map<string, Buffer>; hash: string }
type Side = 'candidate' | 'original'
type Failure = { status: 'failed' | 'blocked' | 'skipped' | 'cancelled'; reason: string }

/** Where and how every sample of one loop runs. */
type Samples = {
  execution: ExecutionPolicy
  trustedRoot: string
  modules: string | null
  timeoutMs: number
  signal: AbortSignal
}

function problem(result: CommandResult): Failure | undefined {
  if (result.aborted) {
    return { status: 'cancelled', reason: 'Verification interrupted' }
  }

  if (result.timedOut) {
    return { status: 'blocked', reason: 'Command timed out' }
  }

  if (result.exitCode === null || result.truncated) {
    return { status: 'blocked', reason: 'Incomplete command result' }
  }

  if (isolationUnavailable(result)) {
    return { status: 'blocked', reason: 'Sandbox could not start; commands never fall back' }
  }

  if (result.exitCode === 71 && result.output.startsWith('sandbox-exec: execvp() of ')) {
    return { status: 'blocked', reason: 'Command could not start in the sandbox' }
  }

  if (result.exitCode !== 0) {
    return { status: 'failed', reason: 'Command exited ' + result.exitCode }
  }

  if (hasSkippedTests(result.output)) {
    return { status: 'skipped', reason: 'Skipped cases' }
  }

  return undefined
}

async function capture(root: string): Promise<Snapshot> {
  const files = await inventory(root)
  return { root, files, hash: snapshotHash(files) }
}

async function runSample(snapshot: Snapshot, argv: string[], samples: Samples) {
  const { execution, trustedRoot, modules, timeoutMs, signal } = samples
  const workspace = await createWorkspace(snapshot.root, snapshot.files, modules)

  try {
    const readable = await linkLockedDependencies(
      workspace,
      trustedRoot,
      snapshot.files.keys(),
      execution,
    )
    return await runWorkerCommand(execution, { workspace, argv, timeoutMs, signal, readable })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function median(values: number[]) {
  const ordered = values.toSorted((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle]! : ordered[middle - 1]! / 2 + ordered[middle]! / 2
}

async function runCases(
  input: Input,
  candidate: Snapshot,
  original: Snapshot | undefined,
  project: WorkerRequest['project'],
  signal: AbortSignal,
) {
  const samples: { seed: number; original: number; candidate: number }[] = []
  const order: Side[] = ['original', 'candidate']
  const start = Date.now()
  const run: Samples = {
    execution: await effectiveExecution(project),
    trustedRoot: project.root,
    modules: await installedNodeModules(candidate.root),
    timeoutMs: input.timeoutMs ?? 30000,
    signal,
  }

  for (let index = 0; index < input.count; index++) {
    const seed = input.firstSeed + index
    const argv = input.argv.map((value) => value.replaceAll('{seed}', String(seed)))
    const replay = { ...input, firstSeed: seed, count: 1 }
    const partial = { completed: index, seed, replay, samples, execution: run.execution.mode }
    const outputs: Partial<Record<Side, string>> = {}
    const sides = original ? (index % 2 ? order.toReversed() : order) : (['candidate'] as const)

    for (const side of sides) {
      const snapshot = side === 'original' ? original! : candidate
      let result: CommandResult

      try {
        signal.throwIfAborted()
        result = await runSample(snapshot, argv, run)
      } catch (error) {
        return {
          ...partial,
          side,
          status: signal.aborted ? 'cancelled' : 'blocked',
          reason: String(error).slice(0, 1000),
        }
      }

      const failure = problem(result)

      if (failure) {
        return { ...partial, ...failure, side, output: result.output.slice(-1000) }
      }

      outputs[side] = result.output
    }

    if (input.mode === 'differential') {
      if (!outputs.original?.trim() || !outputs.candidate?.trim()) {
        return { ...partial, status: 'blocked', reason: 'Oracle requires observable output' }
      }

      if (outputs.original !== outputs.candidate) {
        return {
          ...partial,
          status: 'failed',
          reason: 'Output mismatch',
          originalDigest: digest(outputs.original),
          candidateDigest: digest(outputs.candidate),
          originalExcerpt: outputs.original.slice(-500),
          candidateExcerpt: outputs.candidate.slice(-500),
        }
      }
    }

    if (input.mode === 'benchmark') {
      const pair = [outputs.original, outputs.candidate].map((value) => {
        const text = value?.trim()
        return text && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)
          ? Number(text)
          : NaN
      })

      if (!pair.every(Number.isFinite)) {
        return { ...partial, status: 'blocked', reason: 'Benchmark must emit one finite number' }
      }

      samples.push({ seed, original: pair[0]!, candidate: pair[1]! })
    }
  }

  const comparison = samples.length
    ? {
        metric: input.metric,
        originalMedian: median(samples.map((sample) => sample.original)),
        candidateMedian: median(samples.map((sample) => sample.candidate)),
      }
    : undefined
  return {
    status: 'passed',
    completed: input.count,
    samples,
    comparison,
    execution: run.execution.mode,
    elapsedMs: Date.now() - start,
  }
}

export async function verifyLoop(request: WorkerRequest, raw: unknown, signal?: AbortSignal) {
  if (!Check(verificationLoopSchema, raw)) {
    throw new Error('Invalid verification loop arguments')
  }

  const input = raw as Input

  if (Buffer.byteLength(JSON.stringify(input.argv)) > 16000) {
    throw new Error('Verification command exceeds 16 KB')
  }

  if (input.firstSeed + input.count - 1 > 4294967295) {
    throw new Error('Seed range exceeds uint32')
  }

  if (input.mode !== 'benchmark' && !input.argv.some((arg) => arg.includes('{seed}'))) {
    throw new Error('Include {seed} in argv to exercise the requested seeds')
  }

  if (input.mode === 'benchmark' && !input.metric?.trim()) {
    throw new Error('Name the measured benchmark metric and its unit')
  }

  const candidate = await capture(request.workspace)
  const original =
    input.mode !== 'seeded' && request.originals ? await capture(request.originals) : undefined
  const deadline = AbortSignal.timeout(300000)
  const abort = AbortSignal.any([deadline, workerAbortSignal, ...(signal ? [signal] : [])])
  const report =
    input.mode !== 'seeded' && !original
      ? { status: 'blocked', completed: 0, samples: [], reason: 'Original snapshot unavailable' }
      : await runCases(input, candidate, original, request.project, abort)
  const status = deadline.aborted && report.status === 'cancelled' ? 'blocked' : report.status
  const receipt = request.outputPath + '.verify-' + randomUUID() + '.json'
  const { samples, ...summary } = report
  const result = {
    ...summary,
    status,
    ...(deadline.aborted && { reason: 'Verification loop exceeded five minutes' }),
    snapshot: candidate.hash,
    originalSnapshot: original?.hash,
    requested: input.count,
    receipt: basename(receipt),
  }
  await atomicJson(receipt, { ...result, input, samples })
  return result
}
