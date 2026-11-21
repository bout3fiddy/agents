import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore } from '../src/state.ts'
import { fileHashes, inventory, snapshotHash } from '../src/paths.ts'
import type { Design, WorkerRequest, WorkerEvidence, WorkerResult } from '../src/contracts.ts'

export const design: Design = {
  objective: 'A bounded, observable counter',
  design: 'Return the requested value deterministically.',
  invariants: ['No data loss'],
  acceptance: ['Contract tests pass'],
  writePaths: ['src/**', 'benchmarks/**'],
  database: false,
  performance: false,
  unresolved: [],
}

export async function fixture(
  options: {
    database?: boolean
    performance?: boolean
    performanceReview?: boolean
    skip?: boolean
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'pi-harness-test-'))
  const root = join(base, 'project')
  await mkdir(join(root, '.pi'), { recursive: true })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'value.js'), 'export const value = 0\n')
  const checks = [
    {
      id: 'contract',
      argv: [
        'node',
        '-e',
        options.skip ? 'console.log("# skipped 1")' : 'console.log("contract exercised")',
      ],
      required: true,
      kind: 'test',
      timeoutMs: 10000,
    },
  ]

  if (options.database) {
    checks.push({
      id: 'recovery',
      argv: ['node', '-e', 'console.log("recovery exercised")'],
      required: true,
      kind: 'database',
      timeoutMs: 10000,
    })
  }

  if (options.performance) {
    checks.push({
      id: 'latency',
      argv: ['node', '-e', 'console.log("samples=[3,4,3]")'],
      required: true,
      kind: 'benchmark',
      timeoutMs: 10000,
    })
  }

  await writeFile(join(root, '.pi', 'harness.json'), JSON.stringify({ checks }, null, 2) + '\n')
  const store = new StateStore(root, join(base, 'state'))
  const hash = await store.draft({ ...design, ...options })
  await store.accept(hash)
  return { base, root, store }
}

export async function evidence(
  request: Omit<WorkerRequest, 'outputPath'>,
  result: Partial<WorkerResult> = {},
): Promise<WorkerEvidence> {
  return {
    role: request.role,
    snapshot: snapshotHash(await inventory(request.workspace)),
    result: {
      verdict: 'pass',
      summary: 'Verified fixture contract',
      findings: [],
      databaseImpact: false,
      evidence: ['Fixture evidence'],
      ...result,
    },
    commands: [],
    turns: 1,
    model: 'deterministic-test',
  }
}

export async function hashes(root: string) {
  return fileHashes(await inventory(root))
}
