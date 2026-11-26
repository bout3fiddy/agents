import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { linkBranchDependencies } from './branch-runner.ts'
import { childSummary } from './context.ts'
import type { Checkpoint, Project, Receipt, WorkerEvidence } from './contracts.ts'
import {
  checkDelegation,
  DelegationChecksFailed,
  DelegationRepairRequired,
} from './delegation-checks.ts'
import {
  Delegations,
  delegationDirectory,
  type DelegationRequest,
  type DelegationStatus,
  type TaskControls,
} from './delegation-state.ts'
import { dispatcher, type Dispatcher } from './dispatch.ts'
import {
  commitVerifiedTree,
  currentCommit,
  gitCommand,
  type CandidateCheckout,
} from './git-branches.ts'
import { changes } from './integration.ts'
import type { LocalPlan } from './local-contracts.ts'
import { acquireLock, type ReleaseLock } from './lock.ts'
import { digest, fileHashes, inventory, matches, snapshotHash, writable } from './paths.ts'
import { trackDispatch } from './progress.ts'
import { RepairProgress } from './repair-budget.ts'
import { currentPolicyCommit, loadPinnedProject } from './pinned-project.ts'
import { atomicJson, readJson, StateStore } from './state.ts'
import { taskExecution } from './worker-execution.ts'

async function localProject(request: DelegationRequest, signal: AbortSignal) {
  const policy = await currentPolicyCommit(request.root, request.local!.base, signal)
  const project = await loadPinnedProject(request.root, policy, signal)
  const acceptance = request.local!.acceptance

  if (project.checks.some((check) => check.id === acceptance.id)) {
    throw new Error('The pinned project already declares the reserved local acceptance check')
  }

  // The decision belongs to the user's checkout, not to the candidate worktree below it. A task
  // the host marked for isolation keeps it whatever that decision is.
  return {
    ...project,
    root: request.root,
    execution: taskExecution(project.execution, request),
    checks: [...project.checks, acceptance],
  }
}

/** Use the original workload even on a later integration target. Project checks come from the
 * policy committed at the checkout's current HEAD; see currentPolicyCommit. */
export async function verifyLocalSnapshot(
  request: DelegationRequest,
  originals: string,
  workspace: string,
  evidence: WorkerEvidence,
  signal: AbortSignal,
  policyRoot = originals,
  prior: LocalPlan[] = [],
) {
  const project = await localProject(request, signal)
  const before = await inventory(originals)
  const after = await inventory(workspace)
  const policy = policyRoot === originals ? before : await inventory(policyRoot)
  const local = request.local!
  const workload = new Set<string>()
  const required = [local.acceptance]

  for (const [index, plan] of [local, ...prior].entries()) {
    if (plan.base !== local.base || plan.batch !== local.batch) {
      throw new Error('Prior local acceptance must belong to this batch and baseline')
    }

    for (const path of plan.workloadPaths) {
      workload.add(path)
    }

    // Files the acceptance command merely names are pinned so a candidate cannot weaken its own
    // test. An independent task explicitly assigned to repair such a file must be able to change
    // it; explicit workloads and competitions stay pinned.
    const implied = (path: string) =>
      plan.mode === 'competition' || !writable(path, request.writePaths)

    for (const arg of plan.acceptance.argv) {
      const path = arg.replace(/^\.\//, '')

      if (policy.has(path) && implied(path)) {
        workload.add(path)
      }
    }

    if (
      ['npm', 'bun', 'pnpm', 'yarn'].includes(plan.acceptance.argv[0]!) &&
      implied('package.json')
    ) {
      workload.add('package.json')
    }

    const { argv, timeoutMs } = plan.acceptance

    if (
      required.some(
        (check) =>
          JSON.stringify(check.argv) === JSON.stringify(argv) && check.timeoutMs === timeoutMs,
      )
    ) {
      continue
    }

    const id = `local-prior-${index}`

    if (project.checks.some((check) => check.id === id)) {
      throw new Error(`Reserved local acceptance check ID: ${id}`)
    }

    const check = { ...plan.acceptance, id }
    project.checks.push(check)
    required.push(check)
  }

  const protectedPaths = [...workload]

  for (const path of changes(policy, after)) {
    if (protectedPaths.some((scope) => matches(path, scope))) {
      throw new Error(`Pinned local acceptance workload changed: ${path}`)
    }
  }

  const snapshot = snapshotHash(after)
  const receipts = await checkDelegation(
    { ...request, root: originals },
    workspace,
    project,
    before,
    after,
    { ...evidence, children: [evidence], controlRevision: 0 },
    signal,
  )

  if (
    !required.every((check) =>
      receipts.some((r) => r.check === check.id && r.status === 'passed'),
    ) ||
    receipts.some((receipt) => receipt.snapshot !== snapshot) ||
    snapshotHash(await inventory(workspace)) !== snapshot
  ) {
    throw new Error('Local candidate changed during verification or lacks acceptance evidence')
  }

  return receipts
}

async function checkoutCandidate(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
) {
  const { base } = request.local!
  const branch = `pi/${request.id}`
  const workspace = join(store.directory, 'worktrees', request.id)
  await mkdir(join(store.directory, 'worktrees'), { recursive: true, mode: 0o700 })
  const exists = await realpath(workspace).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }

    return undefined
  })

  if (!exists) {
    await gitCommand(request.root, ['worktree', 'add', '-b', branch, '--', workspace, base], signal)
  }

  const gitDir = (path: string) =>
    gitCommand(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal).then(
      (directory) => realpath(directory),
    )

  if (
    (await gitDir(workspace)) !== (await gitDir(request.root)) ||
    (await realpath(await gitCommand(workspace, ['rev-parse', '--show-toplevel'], signal))) !==
      workspace ||
    (await gitCommand(workspace, ['symbolic-ref', '--short', 'HEAD'], signal)) !== branch
  ) {
    throw new Error('Retained local worktree identity or pinned base changed')
  }

  if (!exists) {
    await linkBranchDependencies(request.root, workspace, signal)
  }

  return { root: request.root, branch, base, workspace }
}

type PreparedCommit = {
  parent: string
  tree: string
  snapshot: string
  revision: number
  progressFile: string
  receipts: Receipt[]
}

/** A checked tree may have been committed just before the supervisor stopped. */
async function checkRecordedHead(
  branch: CandidateCheckout,
  prepared: PreparedCommit | undefined,
  signal: AbortSignal,
) {
  const head = await currentCommit(branch, signal)

  if (!prepared) {
    if (head !== branch.base) {
      throw new Error('Retained candidate HEAD moved without a verified commit record')
    }

    return head
  }

  await gitCommand(
    branch.workspace,
    ['merge-base', '--is-ancestor', branch.base, prepared.parent],
    signal,
  )

  if (head !== prepared.parent) {
    const parents = await gitCommand(branch.workspace, ['show', '-s', '--format=%P', head], signal)
    const tree = await gitCommand(branch.workspace, ['rev-parse', head + '^{tree}'], signal)

    if (parents !== prepared.parent || tree !== prepared.tree) {
      throw new Error('Retained local commit differs from its verified parent or tree')
    }
  }

  return head
}

export async function runLocalCandidate(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  dispatch?: Dispatcher,
): Promise<DelegationStatus> {
  const directory = delegationDirectory(store, request.id)
  const lock = await acquireLock(join(directory, 'local-candidate.lock'))

  try {
    return await executeLocalCandidate(store, request, signal, directory, lock, dispatch)
  } finally {
    await lock()
  }
}

/** Status persistence and task controls for one supervisor run of a local candidate. */
type LocalTask = {
  store: StateStore
  request: DelegationRequest
  local: LocalPlan
  signal: AbortSignal
  directory: string
  dispatch?: Dispatcher
  state: () => DelegationStatus
  save: (update: Partial<DelegationStatus>) => Promise<void>
  controls: () => Promise<TaskControls>
  finish: (revision: number, update: Partial<DelegationStatus>) => Promise<boolean>
}

function localTask(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  directory: string,
  lock: ReleaseLock,
  initial: DelegationStatus,
  dispatch: Dispatcher | undefined,
): LocalTask {
  const statusPath = join(directory, 'status.json')
  const controlsPath = join(directory, 'controls.json')
  let state = initial
  const save = async (update: Partial<DelegationStatus>) => {
    state = { ...state, ...update, updatedAt: new Date().toISOString() }
    await atomicJson(statusPath, state)
  }
  const controls = async () => {
    lock.assertHeld()
    signal.throwIfAborted()
    const current = await readJson<TaskControls>(controlsPath)

    if (!current || current.cancelled || current.paused) {
      throw new Error('Local candidate stopped by task controls')
    }

    return current
  }
  const finish = (revision: number, update: Partial<DelegationStatus>) =>
    new Delegations(store).locked(async () => {
      if ((await controls()).revision !== revision) {
        return false
      }

      await save({ ...update, status: 'complete', error: undefined })
      return true
    })
  return {
    store,
    request,
    local: request.local!,
    signal,
    directory,
    dispatch,
    state: () => state,
    save,
    controls,
    finish,
  }
}

/** One candidate checkout verified against a disposable worktree of its pinned base. */
type LocalSession = {
  task: LocalTask
  branch: CandidateCheckout & { branch: string }
  basePath: string
  project: Project
  before: Map<string, Buffer>
  checkpoint: Checkpoint
  progress: RepairProgress
  head: string
}

/** An implementer round whose candidate snapshot awaits verification. */
type Round = {
  revision: number
  progressFile: string
  evidence: WorkerEvidence
  after: Map<string, Buffer>
  snapshot: string
}

/** The repair loop as explicit states. Each step returns the next; only commit completes. */
type LocalStep =
  | { kind: 'implement'; feedback: string }
  | { kind: 'verify'; round: Round }
  | { kind: 'commit'; round: Round; receipts: Receipt[] }
  | { kind: 'complete' }

const guidanceFeedback = 'Read the newly received scoped guidance and verify the candidate again.'

async function executeLocalCandidate(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  directory: string,
  lock: ReleaseLock,
  dispatch?: Dispatcher,
): Promise<DelegationStatus> {
  const initial = (await readJson<DelegationStatus>(join(directory, 'status.json')))!
  const task = localTask(store, request, signal, directory, lock, initial, dispatch)
  const baseline: { path?: string; linked: boolean } = { linked: false }

  try {
    if (!request.local || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.local.base)) {
      throw new Error('Missing local candidate or invalid pinned commit')
    }

    await task.controls()

    if (task.state().status === 'complete') {
      return task.state()
    }

    await task.save({
      status: 'running',
      pid: process.pid,
      hostActions: undefined,
      error: undefined,
    })
    const branch = await checkoutCandidate(store, request, signal)
    await task.save({
      candidate: branch.workspace,
      branch: branch.branch,
      base: request.local.base,
    })
    const recovered = await recoverPreparedCommit(task, branch)

    if (recovered.complete) {
      return task.state()
    }

    const session = await prepareSession(task, branch, recovered.head, baseline)
    let step: LocalStep = { kind: 'implement', feedback: '' }

    // Bounded per guidance revision by RepairProgress; new guidance comes only from the host.
    while (step.kind !== 'complete') {
      step = await advance(session, step)
    }

    return task.state()
  } catch (error) {
    const control = await readJson<TaskControls>(join(directory, 'controls.json'))
    await task.save({
      status: control?.paused
        ? 'paused'
        : signal.aborted || control?.cancelled
          ? 'cancelled'
          : 'needs_attention',
      error: String(error),
    })
    return task.state()
  } finally {
    if (baseline.path) {
      if (baseline.linked) {
        await rm(join(baseline.path, 'node_modules'), { force: true })
        await rm(join(baseline.path, '.venv'), { force: true })
      }

      await gitCommand(request.root, ['worktree', 'remove', '--', baseline.path])
    }
  }
}

/** A checked tree may have been committed just before the supervisor stopped. Finish from that
 * record when its guidance revision is still current. */
async function recoverPreparedCommit(
  task: LocalTask,
  branch: CandidateCheckout,
): Promise<{ complete: boolean; head: string }> {
  const prepared = await readJson<PreparedCommit>(join(task.directory, 'local-commit.json'))
  const head = await checkRecordedHead(branch, prepared, task.signal)

  if (!prepared || (await task.controls()).revision !== prepared.revision) {
    return { complete: false, head }
  }

  const evidence = await readJson<WorkerEvidence>(join(task.directory, prepared.progressFile))
  const files = await inventory(branch.workspace)

  if (
    evidence?.role !== 'implementer' ||
    evidence.result.verdict !== 'pass' ||
    evidence.snapshot !== prepared.snapshot ||
    snapshotHash(files) !== prepared.snapshot ||
    !prepared.receipts.some((r) => r.check === task.local.acceptance.id && r.status === 'passed') ||
    prepared.receipts.some((r) => r.snapshot !== prepared.snapshot)
  ) {
    throw new Error('Retained candidate no longer matches its verified evidence')
  }

  const commit = await commitVerifiedTree(
    branch,
    {
      message: task.request.task.slice(0, 200).replaceAll('\n', ' '),
      writePaths: task.request.writePaths,
      expectedSnapshot: prepared.snapshot,
    },
    branch.base,
    task.signal,
    async (tree) => {
      if (tree !== prepared.tree) {
        throw new Error('Retained candidate index differs from its verified tree')
      }
    },
  )
  const complete = await task.finish(prepared.revision, {
    commit,
    receipts: prepared.receipts,
    children: [childSummary(evidence)],
    progressFile: prepared.progressFile,
    receiptAttempt: prepared.progressFile,
    summary: evidence.result.summary,
    error: undefined,
  })
  return { complete, head: commit }
}

async function prepareSession(
  task: LocalTask,
  branch: LocalSession['branch'],
  head: string,
  baseline: { path?: string; linked: boolean },
): Promise<LocalSession> {
  const { request, local, store, signal } = task
  await mkdir(join(store.directory, 'baselines'), { recursive: true, mode: 0o700 })
  const basePath = join(store.directory, 'baselines', randomUUID())
  await gitCommand(
    request.root,
    ['worktree', 'add', '--detach', '--', basePath, local.base],
    signal,
  )
  baseline.path = basePath
  baseline.linked = await linkBranchDependencies(request.root, basePath, signal)
  const checkpoint: Checkpoint = {
    objective: local.mode === 'competition' ? request.task : local.objective,
    design: request.context || request.task,
    writePaths: request.writePaths,
    acceptance: [JSON.stringify(local.acceptance.argv)],
    invariants: ['Preserve the pinned workload and all unrelated behavior.'],
    unresolved: [],
    database: false,
    performance: false,
    version: 1,
    hash: digest(JSON.stringify(request)),
    acceptedAt: request.createdAt,
  }
  return {
    task,
    branch,
    basePath,
    project: await localProject(request, signal),
    before: await inventory(basePath),
    checkpoint,
    progress: new RepairProgress('Repair'),
    head,
  }
}

async function advance(session: LocalSession, step: LocalStep): Promise<LocalStep> {
  switch (step.kind) {
    case 'implement':
      return implementRound(session, step.feedback)
    case 'verify':
      return verifyRound(session, step.round)
    case 'commit':
      return commitRound(session, step.round, step.receipts)
    case 'complete':
      return step
  }
}

/** Hand the candidate to the implementer and capture the snapshot it returns. */
async function implementRound(session: LocalSession, feedback: string): Promise<LocalStep> {
  const { task, branch } = session
  const current = await task.controls()
  const progressFile = `implementer-${randomUUID()}.json`
  const output = join(task.directory, progressFile)
  await task.save({
    status: 'running',
    progressFile,
    receipts: undefined,
    receiptAttempt: undefined,
  })
  const child = trackDispatch(
    task.dispatch ?? dispatcher(new StateStore(task.request.root, task.directory)),
    output,
  )
  const evidence = await child(
    {
      role: 'implementer',
      thinking: task.request.thinking,
      implementerModel: task.request.implementerModel,
      task: JSON.stringify({
        task: task.request.task,
        updates: current.messages,
        feedback,
        previousHostHandoff: current.previousHostHandoff,
      }),
      model: task.request.model,
      workspace: branch.workspace,
      checkout: await checkoutEvidence(session),
      project: session.project,
      checkpoint: session.checkpoint,
      baseline: fileHashes(session.before),
      originals: session.basePath,
    },
    task.signal,
  )
  await atomicJson(output, evidence)
  await task.controls()
  const after = await inventory(branch.workspace)
  const snapshot = snapshotHash(after)
  await task.save({
    summary: evidence.result.summary,
    status: 'checking',
    children: [...(task.state().children ?? []), childSummary(evidence)],
    changedPaths: changes(session.before, after),
    hostActions: evidence.result.hostActions,
  })

  if (
    evidence.role !== 'implementer' ||
    evidence.result.verdict !== 'pass' ||
    evidence.snapshot !== snapshot
  ) {
    throw new Error(`Local implementer ${evidence.result.verdict}: ${evidence.result.summary}`)
  }

  // An unchanged candidate would reproduce the same failure. Return the implementer's host
  // handoff now instead of spending another verification on identical bytes.
  const repeated = session.progress.unchanged(current.revision, snapshot)

  if (repeated) {
    await task.save({ receipts: repeated.receipts, receiptAttempt: progressFile })
    throw session.progress.stalledUnchanged(repeated)
  }

  return {
    kind: 'verify',
    round: { revision: current.revision, progressFile, evidence, after, snapshot },
  }
}

/** The worker cannot open Git metadata. Capture checkout evidence before each handoff,
 * including repairs that keep uncommitted edits from the previous attempt. */
async function checkoutEvidence(session: LocalSession) {
  const { branch, head } = session
  const status = await gitCommand(
    branch.workspace,
    ['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '--untracked-files=normal'],
    session.task.signal,
  )
  const lines = status.split('\n')

  if (
    !lines.includes('# branch.oid ' + head) ||
    !lines.includes('# branch.head ' + branch.branch)
  ) {
    throw new Error('Candidate branch or HEAD changed before implementation')
  }

  return { pinnedBase: branch.base, head, clean: lines.every((line) => line.startsWith('# ')) }
}

/** Run the gate. A failure returns to the implementer until RepairProgress stops the loop. */
async function verifyRound(session: LocalSession, round: Round): Promise<LocalStep> {
  const { task } = session
  let receipts

  try {
    receipts = await verifyLocalSnapshot(
      task.request,
      session.basePath,
      session.branch.workspace,
      round.evidence,
      task.signal,
    )
  } catch (error) {
    if (
      !(error instanceof DelegationChecksFailed) &&
      !(error instanceof DelegationRepairRequired)
    ) {
      throw error
    }

    let feedback = error.message
    let failedReceipts: Receipt[] | undefined

    if (error instanceof DelegationChecksFailed) {
      await task.save({ receipts: error.receipts, receiptAttempt: round.progressFile })
      const failed = error.receipts.filter((r) => r.status !== 'passed')

      if (failed.some((r) => r.status === 'unavailable')) {
        throw error
      }

      failedReceipts = error.receipts
      feedback = JSON.stringify(
        failed.map((r) => ({
          check: r.check,
          status: r.status,
          output: r.scopedLintOutput ?? r.result.output.slice(-4000),
        })),
      )
    }

    session.progress.failed(
      {
        revision: round.revision,
        snapshot: round.snapshot,
        message: error.message,
        receipts: failedReceipts,
      },
      round.after,
      error,
    )
    return { kind: 'implement', feedback }
  }

  await task.save({ receipts, receiptAttempt: round.progressFile })

  if ((await task.controls()).revision !== round.revision) {
    return { kind: 'implement', feedback: guidanceFeedback }
  }

  return { kind: 'commit', round, receipts }
}

/** Commit the verified bytes, recording the prepared commit first so a restart can finish it. */
async function commitRound(
  session: LocalSession,
  round: Round,
  receipts: Receipt[],
): Promise<LocalStep> {
  const { task, branch } = session

  if ((await currentCommit(branch, task.signal)) !== session.head) {
    throw new Error('Candidate branch HEAD changed during verification')
  }

  const commit = await commitVerifiedTree(
    branch,
    {
      message: task.request.task.slice(0, 200).replaceAll('\n', ' '),
      writePaths: task.request.writePaths,
      expectedSnapshot: round.snapshot,
    },
    branch.base,
    task.signal,
    (tree) =>
      atomicJson(join(task.directory, 'local-commit.json'), {
        parent: session.head,
        tree,
        snapshot: round.snapshot,
        revision: round.revision,
        progressFile: round.progressFile,
        receipts,
      } satisfies PreparedCommit),
  )
  session.head = commit

  if (await task.finish(round.revision, { commit })) {
    return { kind: 'complete' }
  }

  return { kind: 'implement', feedback: guidanceFeedback }
}
