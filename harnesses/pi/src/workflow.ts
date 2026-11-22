import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type {
  Checkpoint,
  ImplementerModel,
  Project,
  Receipt,
  WorkerEvidence,
  WorkerResult,
  WorkerRole,
  WorkerThinking,
} from './contracts.ts'
import type { ReleaseLock } from './lock.ts'
import { RepairProgress } from './repair-budget.ts'
import { StateStore, atomicJson, type TaskState } from './state.ts'
import { dispatcher, type Dispatcher } from './dispatch.ts'
import { createWorkspace, hasSkippedTests, loadProject, verifyProject } from './project.ts'
import { changes, integrate, recoverIntegration } from './integration.ts'
import {
  documentPath,
  fileHashes,
  inventory,
  matches,
  snapshotHash,
  writable,
  rejectIgnoredAdditions,
} from './paths.ts'
import { runSandboxed } from './sandbox.ts'
import { retainedCandidate } from './resume.ts'
import { receiptView } from './context.ts'

// A changed adapter can alter transaction semantics below an unchanged driver import.
const databaseStatements = new RegExp(
  [
    String.raw`\b(?:create|alter|drop)\s+(?:table|index|schema)|\binsert\s+into\b|`,
    String.raw`\b(?:delete\s+from|begin\s+transaction)\b|\bupdate\s+\w+\s+set\b|`,
    String.raw`\b(?:select\s+[^;\n]{1,200}\s+from|pg_dump|pg_restore|redis-cli)\b|`,
    String.raw`\b(?:db|database|prisma)\.(?:transaction|\$transaction|query|execute)\s*\(`,
  ].join(''),
  'i',
)
const driver =
  '(?:pg|postgres(?:ql)?|psycopg[23]?|sqlite3?|redis|ioredis|prisma|drizzle-orm|' +
  'mongoose|mysql2?|mongodb|knex|sqlalchemy)'
const pythonDatabaseDependency = new RegExp(String.raw`^\s*${driver}(?:\[|\s|[<=>!~;]|$)`, 'im')
const databaseDriver = new RegExp(
  [
    String.raw`(?:\b(?:from|import|require)\s*\(?\s*['"]?(?:node:|better-|@)?${driver}\b|`,
    String.raw`\b(?:from|import|require)\s*\(?\s*['"](?:[@\w.-]+\/)+${driver}['"]|`,
    String.raw`\b${driver}(?:\+\w+)?:\/\/|`,
    String.raw`\b(?:image|engine|provider|dialect|driver)['"]?\s*[:=]\s*['"]?${driver}\b|`,
    String.raw`['"](?:better-|@)?${driver}(?:\/client)?['"]\s*:)`,
  ].join(''),
  'i',
)

export function databaseImpact(
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  paths: string[],
): boolean {
  return changes(before, after).some((path) => {
    if (paths.some((scope) => matches(path, scope)) || /\.(?:sql|prisma)$/i.test(path)) {
      return true
    }

    if (/(?:^|\/)requirements(?:[.-][^/]*)?\.txt$/i.test(path)) {
      return [before.get(path), after.get(path)].some(
        (bytes) => bytes && pythonDatabaseDependency.test(bytes.toString('utf8')),
      )
    }

    if (documentPath(path) || /\.(?:mdx|markdown|adoc)$/i.test(path)) {
      return false
    }

    return [before.get(path), after.get(path)].some((bytes) => {
      if (!bytes || bytes.includes(0)) {
        return false
      }

      let source = bytes.toString('utf8')

      if (/\.[cm]?[jt]sx?$/i.test(path)) {

        // A leading line comment can say "select ... from" in prose. Stop at the first
        // source token so SQL in strings, templates and executable code remains visible.
        source = source.replace(/^(?:[ \t]*\/\/[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)+/, '')
      }

      // NatSpec annotations describe contract behavior in prose.
      const code = path.endsWith('.vy')
        ? source.replace(/^[ \t]*(?:"{3}|'{3})?@(?:notice|dev|param|return)\b[^\n]*/gm, '')
        : source
      return databaseStatements.test(code) || databaseDriver.test(code)
    })
  })
}

function failed(receipts: Receipt[], project: Project): Receipt[] {
  return receipts.filter(
    (item) =>
      item.status !== 'passed' &&
      (item.check.startsWith('required-') ||
        item.check === 'harness-lint' ||
        project.checks.find((check) => check.id === item.check)?.required),
  )
}

export async function benchmarks(
  workspace: string,
  project: Project,
  signal?: AbortSignal,
): Promise<Receipt[]> {
  const snapshot = snapshotHash(await inventory(workspace))
  const receipts: Receipt[] = []

  for (const check of project.checks.filter((item) => item.kind === 'benchmark')) {
    const probe = await createWorkspace(workspace)
    const result = await runSandboxed(probe, check.argv, check.timeoutMs, signal).finally(() =>
      rm(probe, { recursive: true, force: true }),
    )
    receipts.push({
      snapshot,
      check: check.id,
      status:
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.aborted &&
        !result.truncated &&
        !hasSkippedTests(result.output)
          ? 'passed'
          : 'failed',
      result,
    })
  }

  if (!project.checks.some((check) => check.kind === 'benchmark' && check.required)) {
    receipts.push({
      snapshot,
      check: 'required-benchmark',
      status: 'unavailable',
      result: {
        argv: [],
        exitCode: null,
        output: 'Declare a required benchmark check in .pi/harness.json',
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 0,
      },
    })
  }

  return receipts
}

type WorkflowRole = Exclude<WorkerRole, 'task-worker' | 'progress-auditor'>

/** One implementation workflow over a retained or fresh candidate of the accepted design. */
type WorkflowRun = {
  store: StateStore
  model: string
  signal?: AbortSignal
  dispatch: Dispatcher
  thinking: Partial<Record<WorkflowRole, WorkerThinking>>
  implementerModel?: ImplementerModel
  release: ReleaseLock
  checkpoint: Checkpoint
  project: Project
  before: Map<string, Buffer>
  retained?: { task: TaskState; readyForReview: boolean }
  outstanding: WorkerResult[]
  workspace: string
  originals: string
  task: TaskState
  needsDatabase: boolean
  baseline: Receipt[]
  progress: RepairProgress
  lastFailure: string
}

/** The workflow as explicit states: implement → verify → integrate → complete. */
type WorkflowStep =
  | { kind: 'implement'; feedback: string; round: number }
  | { kind: 'verify'; round: number }
  | { kind: 'integrate'; candidate: Map<string, Buffer> }
  | { kind: 'complete' }

export async function runWorkflow(
  store: StateStore,
  model: string,
  signal?: AbortSignal,
  dispatch: Dispatcher = dispatcher(store),
  thinking: Partial<Record<WorkflowRole, WorkerThinking>> = {},
  implementerModel?: ImplementerModel,
): Promise<TaskState> {
  const release = await store.lock()
  const opened: { task?: TaskState } = {}

  try {
    await recoverIntegration(store)
    const checkpoint = await acceptedCheckpoint(store)
    const run = await openWorkflow(
      { store, model, signal, dispatch, thinking, implementerModel, release, checkpoint },
      opened,
    )
    let step: WorkflowStep = { kind: 'implement', feedback: initialFeedback(run), round: 1 }

    // RepairProgress bounds failed verifications. A worker round that returns without passing
    // repeats only while its feedback or the candidate changes.
    while (step.kind !== 'complete') {
      step = await advanceWorkflow(run, step)
    }

    return run.task
  } catch (error) {
    const task = opened.task

    if (!task) {
      throw error
    }

    task.status = signal?.aborted ? 'interrupted' : 'needs_attention'
    task.error = error instanceof Error ? error.message : String(error)
    await store.saveTask(task)
    return task
  } finally {
    await release()
  }
}

async function acceptedCheckpoint(store: StateStore): Promise<Checkpoint> {
  const checkpoint = await store.checkpoint()

  if (!checkpoint) {
    throw new Error('Supply a settled design to workflow before running implementation')
  }

  if (checkpoint.unresolved.length) {
    throw new Error('Resolve design questions before implementation')
  }

  return checkpoint
}

type WorkflowInputs = Pick<
  WorkflowRun,
  | 'store'
  | 'model'
  | 'signal'
  | 'dispatch'
  | 'thinking'
  | 'implementerModel'
  | 'release'
  | 'checkpoint'
>

/** Check the project's required evidence, then open the candidate and its task record. */
async function openWorkflow(
  inputs: WorkflowInputs,
  opened: { task?: TaskState },
): Promise<WorkflowRun> {
  const { store, checkpoint, signal } = inputs
  const project = await loadProject(store.projectRoot)
  const requiredKinds = [
    'test',
    ...(checkpoint.database ? ['database'] : []),
    ...(checkpoint.performance ? ['benchmark'] : []),
  ]
  const missing = requiredKinds.filter(
    (kind) => !project.checks.some((check) => check.required && check.kind === kind),
  )

  if (missing.length) {
    throw new Error(`Configure required ${missing.join(', ')} checks in .pi/harness.json`)
  }

  const before = await inventory(store.projectRoot)
  const retained = await retainedCandidate(store, checkpoint, before)
  const owner = {
    projectRoot: store.projectRoot,
    stateDirectory: store.directory,
    taskId: randomUUID(),
  }
  const source = retained?.task.candidate ?? store.projectRoot
  const workspace = await createWorkspace(source, undefined, undefined, owner)
  const originals = await createWorkspace(store.projectRoot, undefined, undefined, owner)
  const task: TaskState = {
    id: owner.taskId,
    designHash: checkpoint.hash,
    designVersion: checkpoint.version,
    status: 'running',
    phase: 'implementation',
    round: 0,
    candidate: workspace,
    resumedFrom: retained?.task.id,
    evidence: retained?.task.evidence ?? [],
    receipts: [],
  }
  opened.task = task
  await store.saveTask(task)
  await atomicJson(join(store.directory, 'tasks', `${task.id}.baseline.json`), fileHashes(before))
  const outstanding = ['reviewer', 'database-reviewer'].flatMap((role) => {
    const prior = retained?.task.evidence.findLast((item) => item.role === role)
    return prior && prior.result.verdict !== 'pass' ? [prior.result] : []
  })
  const baseline = checkpoint.performance ? await benchmarks(originals, project, signal) : []
  await atomicJson(join(store.directory, 'tasks', `${task.id}.baseline-benchmarks.json`), baseline)
  return {
    ...inputs,
    project,
    before,
    retained,
    outstanding,
    workspace,
    originals,
    task,
    needsDatabase:
      checkpoint.database ||
      Boolean(retained?.readyForReview && retained.task.reviewRound?.database) ||
      outstanding.some((finding) => finding.databaseImpact) ||
      Boolean(retained?.task.evidence.some((item) => item.role === 'database-reviewer')),
    baseline,
    progress: new RepairProgress('Workflow repair'),
    lastFailure: '',
  }
}

function initialFeedback(run: WorkflowRun): string {
  const { retained, outstanding } = run
  return retained
    ? JSON.stringify({
        assignment:
          'Continue the retained candidate. Resolve prior findings and preserve valid work.',
        error: retained.task.error,
        outstandingFindings: outstanding,
        reviews: retained.task.evidence.slice(-4).map((item) => item.result),
        checks: retained.task.receipts.map(receiptView),
      })
    : 'Implement the accepted design. Preserve unrelated work and return concrete evidence.'
}

async function advanceWorkflow(run: WorkflowRun, step: WorkflowStep): Promise<WorkflowStep> {
  switch (step.kind) {
    case 'implement':
      return implementRound(run, step.feedback, step.round)
    case 'verify':
      return verifyRound(run, step.round)
    case 'integrate':
      return integrateRound(run, step.candidate)
    case 'complete':
      return step
  }
}

async function dispatchWorker(
  run: WorkflowRun,
  role: WorkflowRole,
  assignment: string,
): Promise<WorkerEvidence> {
  const { task, signal, workspace } = run
  signal?.throwIfAborted()
  const implementer = task.evidence.findLast((item) => item.role === 'implementer')
  const evidence = await run.dispatch(
    {
      role,
      ...(role === 'implementer' && { implementerModel: run.implementerModel }),
      reviewOf: role === 'performance' ? implementer?.liveWorkerId : undefined,
      thinking: run.thinking[role],
      task: assignment,
      workspace,
      project: run.project,
      checkpoint: run.checkpoint,
      model: run.model,
      baseline: fileHashes(run.before),
      originals: run.originals,
    },
    signal,
  )
  signal?.throwIfAborted()

  if (evidence.role !== role || evidence.snapshot !== snapshotHash(await inventory(workspace))) {
    throw new Error(`Stale or mismatched ${role} evidence`)
  }

  task.evidence.push(evidence)
  await run.store.saveTask(task)
  return evidence
}

/** Implement, then measure when the design asks for a performance review. */
async function implementRound(
  run: WorkflowRun,
  feedback: string,
  round: number,
): Promise<WorkflowStep> {
  const { task, checkpoint } = run
  run.signal?.throwIfAborted()

  if (feedback) {
    const failure = snapshotHash(await inventory(run.workspace)) + feedback

    if (failure === run.lastFailure) {
      throw new Error(
        'The same failure persisted without candidate changes; ' +
          'inspect retained evidence and resolve the missing prerequisite on the host',
      )
    }

    run.lastFailure = failure
  }

  task.round = round
  task.phase = 'implementation'
  await run.store.saveTask(task)

  if (round === 1 && run.retained?.readyForReview && !run.outstanding.length) {
    return { kind: 'verify', round }
  }

  const implementation = await dispatchWorker(run, 'implementer', feedback)

  if (implementation.result.verdict === 'blocked') {
    task.hostActions = implementation.result.hostActions
    throw new Error(`Implementation blocked: ${implementation.result.summary}`)
  }

  run.needsDatabase ||= implementation.result.databaseImpact

  if (implementation.result.verdict === 'changes') {
    return { kind: 'implement', feedback: JSON.stringify(implementation.result), round: round + 1 }
  }

  if (!checkpoint.performanceReview) {
    return { kind: 'verify', round }
  }

  task.phase = 'performance'
  await run.store.saveTask(task)
  const measurement = await dispatchWorker(
    run,
    'performance',
    JSON.stringify({
      assignment:
        'Add or improve benchmarks and report measurements. Do not optimize product code.',
      baselineBenchmarks: run.baseline.map(receiptView),
      previousFeedback: feedback,
    }),
  )
  run.needsDatabase ||= measurement.result.databaseImpact

  if (measurement.result.verdict !== 'pass') {
    return { kind: 'implement', feedback: JSON.stringify(measurement.result), round: round + 1 }
  }

  return { kind: 'verify', round }
}

/** Check scope and run the gate; failures return to the implementer until RepairProgress stops. */
async function verifyRound(run: WorkflowRun, round: number): Promise<WorkflowStep> {
  const { task, store, checkpoint, project, workspace, signal } = run
  const candidate = await inventory(workspace)
  await rejectIgnoredAdditions(store.projectRoot, run.before, candidate)

  for (const path of changes(run.before, candidate)) {
    if (!writable(path, checkpoint.writePaths)) {
      throw new Error(`Out-of-scope edit: ${path}`)
    }
  }

  run.needsDatabase ||= databaseImpact(run.before, candidate, project.databasePaths)
  task.phase = 'verification'
  task.snapshot = snapshotHash(candidate)
  const lintBaseline = { files: run.before, writePaths: checkpoint.writePaths }
  task.receipts = await verifyProject(workspace, project, run.needsDatabase, signal, lintBaseline)

  if (checkpoint.performance) {
    task.receipts.push(...(await benchmarks(workspace, project, signal)))
  }

  await store.saveTask(task)
  const failures = failed(task.receipts, project)

  if (failures.length) {
    if (failures.some((item) => item.status === 'unavailable')) {
      throw new Error('Configure the missing required checks in .pi/harness.json')
    }

    const message = `Required checks failed: ${failures.map((item) => item.check).join(', ')}`
    run.progress.failed(
      { revision: 0, snapshot: task.snapshot, message, receipts: failures },
      candidate,
      new Error(message),
    )
    const feedback = JSON.stringify({ requiredChecks: failures.map(receiptView) })
    return { kind: 'implement', feedback, round: round + 1 }
  }

  if (snapshotHash(await inventory(workspace)) !== task.snapshot) {
    throw new Error('Candidate changed after verification')
  }

  return { kind: 'integrate', candidate }
}

/** Apply the verified candidate to the project and verify the integrated result. */
async function integrateRound(
  run: WorkflowRun,
  candidate: Map<string, Buffer>,
): Promise<WorkflowStep> {
  const { task, store, checkpoint, project, signal } = run
  const currentDesign = await store.checkpoint()

  if (currentDesign?.hash !== checkpoint.hash || currentDesign.version !== checkpoint.version) {
    throw new Error('Accepted design changed during implementation')
  }

  if (snapshotHash(await inventory(store.projectRoot)) !== snapshotHash(run.before)) {
    throw new Error('Project changed during verification; preserve both versions and rerun')
  }

  task.status = 'applying'
  task.phase = 'integration'
  await store.saveTask(task)
  run.release.assertHeld()
  await integrate(store, run.before, candidate, checkpoint.writePaths)
  const lintBaseline = { files: run.before, writePaths: checkpoint.writePaths }
  task.receipts = await verifyProject(
    store.projectRoot,
    project,
    run.needsDatabase,
    signal,
    lintBaseline,
  )

  if (checkpoint.performance) {
    task.receipts.push(...(await benchmarks(store.projectRoot, project, signal)))
  }

  if (failed(task.receipts, project).length) {
    throw new Error('Post-integration checks failed; inspect retained receipts and candidate')
  }

  const verifiedSnapshot = task.snapshot

  if (
    snapshotHash(await inventory(store.projectRoot)) !== verifiedSnapshot ||
    task.receipts.some((receipt) => receipt.snapshot !== verifiedSnapshot)
  ) {
    throw new Error('Integrated project changed during verification')
  }

  task.status = 'complete'
  task.phase = 'complete'
  await store.saveTask(task)
  await rm(run.workspace, { recursive: true, force: true })
  await rm(run.originals, { recursive: true, force: true })
  return { kind: 'complete' }
}
