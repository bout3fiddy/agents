import { spawn } from 'node:child_process'
import { mkdir, open, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  validateDesign,
  type Checkpoint,
  type Project,
  type Receipt,
  type WorkerEvidence,
  type WorkerRole,
} from './contracts.ts'
import { receiptView } from './context.ts'
import { dispatcher, type Dispatcher } from './dispatch.ts'
import { checkDocuments } from './document-tools.ts'
import { benchmarks, changes, databaseImpact, failedChecks } from './job-checks.ts'
import {
  advanceBranch,
  applyToCheckout,
  branchTip,
  checkoutHead,
  commitPaths,
  materialize,
  openRepository,
  pin,
  replay,
  resolveCommit,
  snapshotCheckout,
  type Repository,
} from './job-git.ts'
import {
  jobDirectory,
  jobLabel,
  jobLimits,
  JobStore,
  type Job,
  type JobResult,
} from './job-store.ts'
import {
  digest,
  fileHashes,
  inventory,
  rejectIgnoredAdditions,
  snapshotHash,
  writable,
} from './paths.ts'
import {
  harnessRoot,
  installedNodeModules,
  installedVirtualEnvironment,
  loadProject,
  verifyProject,
} from './project.ts'
import { RepairProgress } from './repair-budget.ts'
import { atomicJson } from './state.ts'
import { temporaryDirectory } from './temp.ts'
import { taskExecution } from './worker-execution.ts'

/** How a run ended, before it is written to the store. */
type Outcome = {
  status: 'done' | 'needs_attention'
  summary: string
  error?: string
  head?: string
  result: JobResult
}

/** Everything one run of a job works with. Built once; the rounds only read it. */
type Run = {
  store: JobStore
  job: Job
  signal: AbortSignal
  dispatch: Dispatcher
  repo: Repository
  project: Project
  checkpoint: Checkpoint
  base: string
  before: Map<string, Buffer>
  workspace: string
  originals: string

  /** Temporary directories holding the two copies; removed when the run ends. */
  containers: string[]
  role: WorkerRole
  needsDatabase: boolean
}

/** What a passing round leaves for delivery. */
type Candidate = {
  after: Map<string, Buffer>
  changed: string[]
  evidence: WorkerEvidence
  receipts: Receipt[]
}

const attention = (summary: string, result: JobResult = {}, error?: string): Outcome => ({
  status: 'needs_attention',
  summary,
  error: error ?? summary,
  result,
})

/** A job without a settled design still gives its worker a scope and a contract to read. */
function checkpointFor(job: Job): Checkpoint {
  const { spec } = job
  const design = spec.design
    ? validateDesign(spec.design)
    : {
        objective: spec.title,
        design: spec.task,
        invariants: ['Stay inside the assigned write scope and preserve unrelated work.'],
        acceptance: ['The assignment is complete and its result reports the evidence.'],
        writePaths: spec.writePaths,
        database: false,
        performance: false,
        unresolved: [],
      }
  return {
    ...design,
    writePaths: spec.writePaths,
    version: 1,
    hash: digest(JSON.stringify(design)),
    acceptedAt: job.createdAt,
    ...(spec.isolation && { isolation: spec.isolation }),
  }
}

/**
 * A retry after a delivery conflict starts from the checkout as it stands now. The earlier work
 * is replayed on it when the two do not touch the same lines; otherwise the worker redoes the
 * task on the current files.
 */
async function rebase(store: JobStore, job: Job, repo: Repository): Promise<string> {
  const base = await snapshotCheckout(repo, (await inventory(job.root)).keys())
  const earlier = job.head ?? job.wip
  const wip =
    earlier &&
    (await replay(repo, {
      base: job.base!,
      onto: base,
      commit: earlier,
      message: `Pi harness work in progress: ${job.spec.title}`,
    }))
  await pin(repo, job.id, 'base', base)

  if (wip) {
    await pin(repo, job.id, 'wip', wip)
  } else {
    store.addMessage(
      job.id,
      `Your earlier result could not be delivered: ${job.result.conflicts!.join(', ')} changed ` +
        'in the checkout meanwhile. You now have the current files. Make the change again on them.',
    )
  }

  store.update(job.id, { base, wip, head: undefined, result: {} })
  return base
}

/**
 * The commit a job starts from, fixed on its first run and reused by every retry, except a
 * retry after a delivery conflict.
 */
async function resolveBase(store: JobStore, job: Job, repo: Repository): Promise<string> {
  if (job.base && job.result.conflicts?.length) {
    return rebase(store, job, repo)
  }

  if (job.base) {
    return job.base
  }

  const { spec } = job
  let base: string | undefined

  if (spec.base) {
    base = await resolveCommit(repo, spec.base, job.root)

    if (!base) {
      throw new Error(`Base ${spec.base} names no commit in this repository`)
    }
  } else if (spec.deliver === 'branch') {
    base = (await branchTip(repo, spec.branch!)) ?? (await checkoutHead(job.root))

    if (!base) {
      throw new Error('Branch delivery needs a commit to start from; this checkout has none')
    }
  } else {
    base = await snapshotCheckout(repo, (await inventory(job.root)).keys())
  }

  await pin(repo, job.id, 'base', base)
  store.update(job.id, { base })
  return base
}

/** A disposable copy of a commit, with the checkout's installed dependencies linked in. */
async function copyOf(repo: Repository, commit: string, root: string) {
  const container = await temporaryDirectory('w')
  const directory = await materialize(repo, commit, container)

  for (const [name, installed] of [
    ['node_modules', await installedNodeModules(root)],
    ['.venv', await installedVirtualEnvironment(root)],
  ] as const) {
    if (installed) {
      await symlink(installed, join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error
        }
      })
    }
  }

  return { container, directory }
}

async function openRun(
  store: JobStore,
  job: Job,
  signal: AbortSignal,
  dispatch: Dispatcher,
): Promise<Run> {
  const { spec } = job
  const repo = await openRepository(job.root, store.directory)

  if (repo.shadow && spec.deliver === 'branch') {
    throw new Error('This directory is not a Git repository; deliver with apply instead')
  }

  const loaded = await loadProject(job.root)
  const project = {
    ...loaded,
    execution: taskExecution(loaded.execution, { isolation: spec.isolation }),
  }
  const checkpoint = checkpointFor(job)

  if (spec.mode === 'implement') {
    const kinds = [
      'test',
      ...(checkpoint.database ? ['database'] : []),
      ...(checkpoint.performance ? ['benchmark'] : []),
    ]
    const missing = kinds.filter(
      (kind) => !project.checks.some((check) => check.required && check.kind === kind),
    )

    if (missing.length) {
      throw new Error(`Configure required ${missing.join(', ')} checks in .pi/harness.json`)
    }
  }

  const base = await resolveBase(store, job, repo)
  job = store.get(job.id)
  const containers: string[] = []
  const copy = async (commit: string) => {
    const made = await copyOf(repo, commit, job.root)
    containers.push(made.container)
    return made.directory
  }
  const originals = await copy(base)
  const workspace = await copy(job.wip ?? base)
  return {
    store,
    job,
    signal,
    dispatch,
    repo,
    project,
    checkpoint,
    base,
    before: await inventory(originals),
    workspace,
    originals,
    containers,
    role: spec.mode === 'implement' || spec.implementerModel ? 'implementer' : 'task-worker',
    needsDatabase: checkpoint.database,
  }
}

/** Record the copy's current state so a later run continues from it. */
async function saveProgress(run: Run, changed: string[]): Promise<string> {
  const wip = await commitPaths(run.repo, {
    from: run.base,
    directory: run.containers[1]!,
    paths: changed,
    parents: [run.base],
    message: `Pi harness work in progress: ${run.job.spec.title}`,
  })
  await pin(run.repo, run.job.id, 'wip', wip)
  run.store.update(run.job.id, { wip })
  return wip
}

async function dispatchWorker(run: Run, role: WorkerRole, task: string, reviewOf?: string) {
  const { job, store, signal } = run
  signal.throwIfAborted()
  const evidence = await run.dispatch(
    {
      role,
      ...(role === 'implementer' && { implementerModel: job.spec.implementerModel }),
      thinking: role === run.role ? job.spec.thinking : undefined,
      task,
      workspace: run.workspace,
      project: run.project,
      checkpoint: run.checkpoint,
      model: job.spec.model,
      baseline: fileHashes(run.before),
      originals: run.originals,
      documentsOnly: job.spec.mode === 'documents',
      reviewOf,
    },
    signal,
    async (progress) => {
      store.update(job.id, {
        phase: [progress.role ?? role, progress.tool ?? progress.stage].join(': ').slice(0, 120),
      })
    },
  )
  signal.throwIfAborted()

  if (evidence.snapshot !== snapshotHash(await inventory(run.workspace))) {
    throw new Error(`The ${role} result does not describe the work it left behind`)
  }

  return evidence
}

/** Scope is checked by the host on the bytes, whatever the worker reported. */
async function checkScope(run: Run, after: Map<string, Buffer>, changed: string[]) {
  const { spec } = run.job
  await rejectIgnoredAdditions(run.job.root, run.before, after)

  for (const path of changed) {
    if (!writable(path, spec.writePaths, spec.mode === 'documents')) {
      throw new Error(
        spec.mode === 'research'
          ? `A read-only job changed a file: ${path}`
          : `Edit outside the assigned write scope: ${path}`,
      )
    }
  }
}

/** Markdown the job changed must be formatted. Returns what the worker has to fix, if anything. */
async function documentFailures(run: Run, after: Map<string, Buffer>, changed: string[]) {
  const markdown = changed.filter((path) => path.endsWith('.md') && after.has(path))
  const failures: string[] = []

  for (let offset = 0; offset < markdown.length; offset += 24) {
    const checked = await checkDocuments(run.workspace, markdown.slice(offset, offset + 24), false)

    if (checked.status !== 'passed') {
      failures.push(...checked.failures)
    }
  }

  return failures
}

/** The host runs the project's checks on the copy. Only these receipts can pass a job. */
async function runChecks(run: Run, after: Map<string, Buffer>): Promise<Receipt[]> {
  const { store, job, project, checkpoint, signal } = run
  run.needsDatabase ||= databaseImpact(run.before, after, project.databasePaths)
  store.update(job.id, { phase: 'checking' })
  const receipts = await verifyProject(run.workspace, project, run.needsDatabase, signal, {
    files: run.before,
    writePaths: job.spec.writePaths,
  })

  if (checkpoint.performance) {
    receipts.push(...(await benchmarks(run.workspace, project, signal)))
  }

  await atomicJson(join(jobDirectory(store, job.id), 'receipts.json'), receipts)
  return receipts
}

function openingTask(run: Run): string {
  const { job } = run

  if (!job.wip) {
    return job.spec.task
  }

  return JSON.stringify({
    assignment: job.spec.task,
    continuation:
      'An earlier run of this job stopped. Its work is in your workspace: keep what is valid ' +
      'and finish the assignment.',
    ...(job.error && { stoppedBecause: job.error }),
    ...(job.result.checks && { lastChecks: job.result.checks }),
  })
}

/**
 * Rounds of work and verification until a candidate passes or cannot progress. The loop is
 * code: which worker runs, when checks run and when to stop are never a model's decision.
 */
async function work(run: Run): Promise<Candidate | Outcome> {
  const { store, job } = run
  const { spec } = job
  const progress = new RepairProgress(`Job ${jobLabel(job)}`)
  let task = openingTask(run)
  let previous = ''
  let author: string | undefined

  for (let round = job.round + 1; ; round++) {
    run.signal.throwIfAborted()
    const guidance = store.takeMessages(job.id)
    const assignment = guidance.length ? JSON.stringify({ task, hostGuidance: guidance }) : task
    const attempt = snapshotHash(await inventory(run.workspace)) + assignment

    if (attempt === previous) {
      return attention(
        'The same request came back with no change to the work. Inspect the retained commit ' +
          'and resolve what is missing before retrying.',
      )
    }

    previous = attempt
    store.update(job.id, { round, phase: 'working' })
    const evidence = await dispatchWorker(run, run.role, assignment)
    author = evidence.liveWorkerId
    const after = await inventory(run.workspace)
    const changed = changes(run.before, after)
    await saveProgress(run, changed)
    const { result } = evidence
    run.needsDatabase ||= result.databaseImpact

    if (result.verdict === 'blocked') {
      return attention(`Blocked: ${result.summary}`, {
        changed,
        hostActions: result.hostActions,
        model: evidence.model,
      })
    }

    await checkScope(run, after, changed)

    if (spec.mode === 'research') {
      return { after, changed, evidence, receipts: [] }
    }

    if (result.verdict === 'changes') {
      task = JSON.stringify({ assignment: spec.task, yourPreviousResult: result })
      continue
    }

    if (spec.mode === 'documents') {
      const failures = await documentFailures(run, after, changed)

      if (!failures.length) {
        return { after, changed, evidence, receipts: [] }
      }

      task = JSON.stringify({ assignment: spec.task, documentChecksFailed: failures })
      continue
    }

    if (run.checkpoint.performanceReview) {
      const measured = await measure(run, author)

      if (measured) {
        task = measured
        continue
      }
    }

    const candidate = await inventory(run.workspace)
    const receipts = await runChecks(run, candidate)
    const failures = failedChecks(receipts, run.project)

    if (!failures.length) {
      return { after: candidate, changed: changes(run.before, candidate), evidence, receipts }
    }

    if (failures.some((receipt) => receipt.status === 'unavailable')) {
      throw new Error('Configure the missing required checks in .pi/harness.json')
    }

    const message = `Required checks failed: ${failures.map((item) => item.check).join(', ')}`
    progress.failed(
      {
        revision: guidance.length ? round : 0,
        snapshot: snapshotHash(candidate),
        message,
        receipts: failures,
      },
      candidate,
      new Error(message),
    )
    task = JSON.stringify({
      assignment: spec.task,
      requiredChecksFailed: failures.map(receiptView),
    })
  }
}

/** The requested performance specialist measures the candidate. Returns feedback on a miss. */
async function measure(run: Run, author: string | undefined): Promise<string | undefined> {
  run.store.update(run.job.id, { phase: 'measuring' })
  const measurement = await dispatchWorker(
    run,
    'performance',
    'Add or improve benchmarks and report measurements. Do not optimize product code.',
    author,
  )
  const after = await inventory(run.workspace)
  await saveProgress(run, changes(run.before, after))
  run.needsDatabase ||= measurement.result.databaseImpact
  return measurement.result.verdict === 'pass'
    ? undefined
    : JSON.stringify({ assignment: run.job.spec.task, performanceFindings: measurement.result })
}

function report(candidate: Candidate): JobResult {
  const { result } = candidate.evidence
  return {
    changed: candidate.changed,
    checks: candidate.receipts.map(({ check, status }) => ({ check, status })),
    findings: result.findings
      .filter((finding) => finding.severity === 'required')
      .map((finding) => `${finding.location}: ${finding.problem}`.slice(0, 600)),
    model: candidate.evidence.model,
  }
}

/** Hand a passing candidate to its target: the checkout's working tree or a local branch. */
async function deliver(run: Run, candidate: Candidate): Promise<Outcome> {
  const { job, repo, store } = run
  const { spec } = job
  const result = report(candidate)
  const summary = candidate.evidence.result.summary

  if (spec.deliver === 'none' || !candidate.changed.length) {
    return { status: 'done', summary, result }
  }

  store.update(job.id, { phase: 'delivering' })
  const head = await commitPaths(repo, {
    from: run.base,
    directory: run.containers[1]!,
    paths: candidate.changed,
    parents: [run.base],
    message: `${spec.title}\n\n${summary.slice(0, 2000)}`,
    identity: 'user',
  })
  await pin(repo, job.id, 'head', head)

  if (spec.deliver === 'branch') {
    await advanceBranch(repo, spec.branch!, head, await branchTip(repo, spec.branch!))
    return { status: 'done', summary, head, result }
  }

  const applied = await applyToCheckout(repo, run.base, head)

  if (applied.conflicts.length) {
    return {
      ...attention(
        'The checkout changed under this job. Nothing was written. The verified result is ' +
          `commit ${head}: retry the job to rebuild it on the current files, or apply it with git.`,
        { ...result, conflicts: applied.conflicts },
      ),
      head,
    }
  }

  return { status: 'done', summary, head, result }
}

async function execute(run: Run): Promise<Outcome> {
  const candidate = await work(run)
  return 'status' in candidate ? candidate : deliver(run, candidate)
}

/**
 * Run one queued job to an outcome. Whatever happens, the job leaves here finished in the
 * store with an event for its session: done, needing the host, or cancelled by the user.
 */
export async function runJob(
  store: JobStore,
  id: string,
  dispatch?: Dispatcher,
): Promise<Job | undefined> {
  if (!store.claim(id, process.pid)) {
    return undefined
  }

  const job = store.get(id)
  const controller = new AbortController()
  const directory = jobDirectory(store, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const beat = setInterval(() => {
    if (store.heartbeat(id)) {
      controller.abort()
    }
  }, jobLimits.heartbeatMs)
  let run: Run | undefined

  try {
    run = await openRun(store, job, controller.signal, dispatch ?? dispatcher(directory))
    const outcome = await execute(run)
    return store.finish(id, outcome.status, {
      summary: outcome.summary,
      error: outcome.error ?? '',
      head: outcome.head,
      result: outcome.result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return controller.signal.aborted
      ? store.finish(id, 'cancelled', { summary: 'Cancelled by the user. Its work is kept.' })
      : store.finish(id, 'needs_attention', { error: message, summary: message })
  } finally {
    clearInterval(beat)

    for (const path of run?.containers ?? []) {
      await rm(path, { recursive: true, force: true })
    }
  }
}

/** Start a detached runner. It outlives the session that asked for the job. */
export async function launchJob(store: JobStore, id: string): Promise<void> {
  const directory = jobDirectory(store, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const log = await open(join(directory, 'runner.log'), 'a', 0o600)

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
          join(harnessRoot, 'src/job-runner.ts'),
          '--job',
          id,
          store.root,
        ],
        {
          cwd: harnessRoot,
          env: { ...process.env, PI_HARNESS_WORKER: '1' },
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
        },
      )
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  } finally {
    await log.close()
  }
}

export type Launcher = typeof launchJob

if (process.argv[2] === '--job') {
  const [id, root] = process.argv.slice(3)

  if (!id || !root) {
    throw new Error('Usage: job-runner.ts --job JOB_ID REPOSITORY_ROOT')
  }

  await runJob(new JobStore(root), id)
}
