import { childSummary } from './context.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { StateStore, atomicJson, readJson } from './state.ts'
import {
  Delegations,
  delegationDirectory,
  type DelegationRequest,
  type DelegationStatus,
  type TaskControls,
} from './delegation-state.ts'
import {
  gitCommand,
  prepareBranch,
  prepareBaseline,
  publishBranch,
  mergeBranch,
  type GitBranch,
} from './git-branches.ts'
import {
  ensureBranchPullRequest,
  awaitBranchChecks,
  GitHubChecksFailed,
  type GitHubPullRequest,
} from './branch-github.ts'
import { runTaskCoordinator, type TaskCoordinatorEvidence } from './task-coordinator.ts'
import {
  checkDelegation,
  DelegationChecksFailed,
  DelegationRepairRequired,
} from './delegation-checks.ts'
import { loadProject } from './project.ts'
import { pinnedDesignInstruction, requireBranchChecks } from './branch-contracts.ts'
import { changes } from './integration.ts'
import { digest, fileHashes, inventory, snapshotHash, readBoundedFile, safePath } from './paths.ts'
import { RepairProgress } from './repair-budget.ts'
import { validateDesign, type Checkpoint, type Project, type Receipt } from './contracts.ts'
import { mergeReviewLoop } from './merge-reviews.ts'

export type BranchAdapters = {
  pullRequest: typeof ensureBranchPullRequest
  checks: typeof awaitBranchChecks
  reviews: typeof mergeReviewLoop
}

/** Link host dependency directories into a worktree. A virtual environment is linked only when
 * the repository ignores the link itself, so it never appears as an untracked candidate file. */
export async function linkBranchDependencies(root: string, workspace: string, signal: AbortSignal) {
  let linked = false

  for (const name of ['node_modules', '.venv']) {
    let target: string

    try {
      target = await realpath(join(root, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }

    if (name === '.venv') {
      try {
        await gitCommand(workspace, ['check-ignore', '-q', '--', name], signal)
      } catch {
        continue
      }
    } else {

      // Dependency links must be ignored by the committed repository policy before host setup.
      await gitCommand(workspace, ['check-ignore', '-q', 'node_modules/'], signal)
    }

    await symlink(target, join(workspace, name))
    linked = true
  }

  return linked
}

type Validated = {
  base: string
  snapshot: string
  evidence: TaskCoordinatorEvidence
  validation: number
}

/** Status persistence and controls for one supervisor run of a branch task. */
type BranchTask = {
  store: StateStore
  request: DelegationRequest
  plan: NonNullable<DelegationRequest['branch']>
  signal: AbortSignal
  directory: string
  coordinate: typeof runTaskCoordinator
  adapters: Partial<BranchAdapters>
  state: () => DelegationStatus
  save: (update: Partial<DelegationStatus>) => Promise<void>
  controls: () => Promise<TaskControls>
  blocked: { actions?: DelegationStatus['hostActions'] }
}

/** The task's branch checkout and the validation and publication records it accumulates. */
type BranchSession = {
  task: BranchTask
  branch: GitBranch
  retained: boolean
  validated?: Validated
  validation: number
  lastBase: string
  children: NonNullable<DelegationStatus['children']>
  previousHead?: string
  discoveredHead?: string
}

/** One validation against a disposable worktree of its base. */
type Validation = {
  session: BranchSession
  base: string
  conflicts: string[]
  originals: string
  baseline: Map<string, Buffer>
  project: Project
  checkpoint: Checkpoint
  progress: RepairProgress
  rounds: number
}

type BranchRound = {
  revision: number
  progressFile: string
  outputPath: string
  evidence: TaskCoordinatorEvidence
  after: Map<string, Buffer>
}

/** Repair within one validation: coordinate → verify → accept, until a snapshot validates. */
type RepairStep =
  | { kind: 'coordinate'; feedback: string }
  | { kind: 'verify'; round: BranchRound }
  | { kind: 'accept'; round: BranchRound; receipts: Receipt[]; revision: number }
  | { kind: 'validated'; snapshot: string }

/** Publication: validate → publish → settle (checks, then publication or the merge queue). */
type PublicationStep =
  | { kind: 'validate'; feedback: string }
  | { kind: 'publish'; snapshot: string }
  | { kind: 'settle'; commit: string; pull?: GitHubPullRequest; message: string }
  | { kind: 'done' }

export async function runBranchTask(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  coordinate = runTaskCoordinator,
  adapters: Partial<BranchAdapters> = {},
): Promise<DelegationStatus> {
  const task = await branchTask(store, request, signal, coordinate, adapters)

  try {
    const session = await openBranch(task)
    let step: PublicationStep = { kind: 'validate', feedback: '' }

    // Each pass ends published, merged, or back at validation after failed remote checks.
    while (step.kind !== 'done') {
      step = await advancePublication(session, step)
    }

    return task.state()
  } catch (error) {
    const control = await readJson<TaskControls>(join(task.directory, 'controls.json'))
    const stopped = control?.paused || signal.aborted || control?.cancelled
    await task.save({
      status: control?.paused
        ? 'paused'
        : signal.aborted || control?.cancelled
          ? 'cancelled'
          : 'needs_attention',
      hostActions: stopped ? undefined : task.blocked.actions,
      error: String(error),
    })
    return task.state()
  }
}

async function branchTask(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  coordinate: typeof runTaskCoordinator,
  adapters: Partial<BranchAdapters>,
): Promise<BranchTask> {
  const directory = delegationDirectory(store, request.id)
  let state: DelegationStatus = {
    ...(await readJson<DelegationStatus>(join(directory, 'status.json'))),
    id: request.id,
    status: 'running',
    hostActions: undefined,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }
  const save = async (update: Partial<DelegationStatus>) => {
    state = { ...state, ...update, updatedAt: new Date().toISOString() }
    await atomicJson(join(directory, 'status.json'), state)
  }
  const controls = async () => {
    signal.throwIfAborted()
    const control = await readJson<TaskControls>(join(directory, 'controls.json'))

    if (!control || control.cancelled) {
      throw new Error('Branch task cancelled or its controls are unavailable')
    }

    if (control.paused) {
      throw new Error('Branch task paused for inspection')
    }

    return control
  }
  await save({})
  return {
    store,
    request,
    plan: request.branch!,
    signal,
    directory,
    coordinate,
    adapters,
    state: () => state,
    save,
    controls,
    blocked: {},
  }
}

/** Validate the pinned design and open or recover the task's branch worktree. */
async function openBranch(task: BranchTask): Promise<BranchSession> {
  const { request, store, signal, directory } = task
  const plan = request.branch

  if (!plan || request.kind !== 'branch') {
    throw new Error('Missing independent branch design')
  }

  // Queued plans retain their pinned design, including the retired review selection.
  const { review: _legacyReview, ...activeDesign } = plan.design as typeof plan.design & {
    review?: boolean
  }
  validateDesign(activeDesign)
  const referenced =
    plan.design.design === pinnedDesignInstruction(plan.designPath, plan.designHash)

  if (
    plan.design.unresolved.length ||
    (!referenced && digest(plan.design.design) !== plan.designHash)
  ) {
    throw new Error('The pinned branch design is unresolved or changed')
  }

  await task.controls()
  const retained = await readJson<GitBranch>(join(directory, 'branch.json'))
  const branch =
    retained ??
    (await prepareBranch(
      request.root,
      request.id,
      {
        remote: plan.remote,
        target: plan.target,
        base: plan.base,
        expectedRemoteUrl: plan.remoteUrl,
      },
      signal,
    ))

  if (
    branch.remoteUrl !== plan.remoteUrl ||
    branch.root !== request.root ||
    branch.branch !== `pi/${request.id}` ||
    branch.workspace !== join(store.directory, 'worktrees', request.id)
  ) {
    throw new Error('The task remote changed after fanout')
  }

  await task.save({ branch: branch.branch, base: branch.base, candidate: branch.workspace })
  await atomicJson(join(directory, 'branch.json'), branch)

  if (!retained) {
    await linkBranchDependencies(request.root, branch.workspace, signal)
  }

  const validated = await readJson<Validated>(join(directory, 'validated.json'))
  return {
    task,
    branch,
    retained: Boolean(retained),
    validated,
    validation: validated?.validation ?? 0,
    lastBase: task.state().mergeBase ?? branch.base,
    children: task.state().children ?? [],
    previousHead: task.state().commit,
  }
}

async function advancePublication(
  session: BranchSession,
  step: PublicationStep,
): Promise<PublicationStep> {
  switch (step.kind) {
    case 'validate':
      return {
        kind: 'publish',
        snapshot: await validateBranch(session, session.lastBase, [], step.feedback),
      }
    case 'publish':
      return publish(session, step.snapshot)
    case 'settle':
      return settle(session, step.commit, step.pull, step.message)
    case 'done':
      return step
  }
}

/** Validate the candidate on a base. A matching recorded validation is reused unchanged. */
async function validateBranch(
  session: BranchSession,
  base: string,
  conflicts: string[],
  feedback = '',
): Promise<string> {
  const { task, branch } = session
  const current = await task.controls()
  const snapshot = snapshotHash(await inventory(branch.workspace))
  const recorded = session.validated

  if (
    !feedback &&
    !conflicts.length &&
    recorded?.base === base &&
    recorded.snapshot === snapshot &&
    recorded.evidence.controlRevision === current.revision
  ) {
    return snapshot
  }

  session.validation++
  session.lastBase = base
  const originals = join(task.store.directory, 'baselines', `${task.request.id}-${randomUUID()}`)
  await mkdir(join(task.store.directory, 'baselines'), { recursive: true, mode: 0o700 })
  await prepareBaseline(branch, base, originals, task.signal)

  // A baseline worktree serves one validation; failures must not leave it behind.
  try {
    const validation = await openValidation(session, base, conflicts, originals)
    let step: RepairStep = { kind: 'coordinate', feedback }

    // Bounded per guidance revision by RepairProgress; coordinator review rounds are uncapped.
    while (step.kind !== 'validated') {
      step = await advanceRepair(validation, step)
    }

    return step.snapshot
  } finally {
    await gitCommand(task.request.root, ['worktree', 'remove', '--force', '--', originals]).catch(
      () => undefined,
    )
  }
}

async function openValidation(
  session: BranchSession,
  base: string,
  conflicts: string[],
  originals: string,
): Promise<Validation> {
  const { request, plan } = session.task
  const baseline = await inventory(originals)
  const document = (await readBoundedFile(await safePath(originals, plan.designPath)))
    .toString('utf8')
    .trimEnd()

  if (digest(document) !== plan.designHash) {
    throw new Error('The design document changed on main; retained branch needs reconciliation')
  }

  const project = { ...(await loadProject(originals)), root: request.root }
  requireBranchChecks(project, plan.design)
  return {
    session,
    base,
    conflicts,
    originals,
    baseline,
    project,
    checkpoint: {
      ...plan.design,
      version: 1,
      hash: digest(JSON.stringify(plan.design)),
      acceptedAt: request.createdAt,
    },
    progress: new RepairProgress('Branch repair'),
    rounds: 0,
  }
}

async function advanceRepair(validation: Validation, step: RepairStep): Promise<RepairStep> {
  switch (step.kind) {
    case 'coordinate':
      return coordinateRound(validation, step.feedback)
    case 'verify':
      return verifyRound(validation, step.round)
    case 'accept':
      return acceptRound(validation, step.round, step.receipts, step.revision)
    case 'validated':
      return step
  }
}

/** One branch orchestrator run over the candidate. */
async function coordinateRound(validation: Validation, feedback: string): Promise<RepairStep> {
  const { session, base } = validation
  const { task, branch } = session
  const { request, plan, directory } = task
  const current = await task.controls()
  validation.rounds++
  await task.save({ status: 'running', mergeBase: base, error: undefined })
  const generation = task.state().deliveryVersion ? `-run-${task.state().deliveryVersion}` : ''
  const progressFile = `orchestrator-${session.validation}-${validation.rounds}${generation}.json`
  const outputPath = join(directory, progressFile)
  await task.save({ progressFile, receipts: undefined, receiptAttempt: undefined })
  const evidence = await task.coordinate(
    {
      kind: 'branch',
      designPath: plan.designPath,
      thinking: request.thinking,
      implementerModel: request.implementerModel,
      task: request.task,
      workspace: branch.workspace,
      project: validation.project,
      checkpoint: validation.checkpoint,
      context: coordinatorContext(validation, current, feedback),
      model: request.model,
      outputPath,
      originals: validation.originals,
      baseline: fileHashes(validation.baseline),
      controlsPath: join(directory, 'controls.json'),
      resumed: (task.state().deliveryVersion ?? 0) > 0,
    },
    task.signal,
  )
  await atomicJson(outputPath, evidence)
  session.children.push(...evidence.children.map(childSummary))
  await task.save({
    children: session.children,
    summary: evidence.result.summary,
    status: 'checking',
  })

  if (evidence.result.verdict === 'blocked') {
    task.blocked.actions = evidence.result.hostActions
    throw new Error(`Autonomous orchestrator blocked: ${evidence.result.summary}`)
  }

  if (evidence.result.verdict !== 'pass') {
    return { kind: 'coordinate', feedback: JSON.stringify(evidence.result) }
  }

  const after = await inventory(branch.workspace)
  await task.save({ changedPaths: changes(validation.baseline, after) })
  const repeated = validation.progress.unchanged(current.revision, snapshotHash(after))

  if (repeated) {
    await task.save({ receipts: repeated.receipts, receiptAttempt: progressFile })
    throw validation.progress.stalledUnchanged(repeated)
  }

  return {
    kind: 'verify',
    round: { revision: current.revision, progressFile, outputPath, evidence, after },
  }
}

function coordinatorContext(validation: Validation, current: TaskControls, feedback: string) {
  const { session, base, conflicts } = validation
  const { task } = session
  const handoff = current.previousHostHandoff
  return JSON.stringify({
    designPath: task.plan.designPath,
    design: task.plan.design.design,
    instruction:
      'Execute autonomously from this settled design. Resolve test and external PR ' +
      'feedback yourself. Preserve other tasks. Do not request routine human approval.',
    phase:
      session.validation === 1 && !session.retained ? 'implementation' : 'integration revalidation',
    baseCommit: base,
    conflicts,
    previousFeedback: feedback,
    ...(handoff &&
      handoff.forDeliveryVersion === task.state().deliveryVersion && {
        previousHostHandoff: { attempt: handoff.attempt, actions: handoff.actions },
      }),
    parentContext: task.request.context,
  })
}

/** Run the gate; a failure returns to the coordinator until RepairProgress stops the loop. */
async function verifyRound(validation: Validation, round: BranchRound): Promise<RepairStep> {
  const { task, branch } = validation.session
  let receipts

  try {
    receipts = await checkDelegation(
      { ...task.request, root: validation.originals },
      branch.workspace,
      validation.project,
      validation.baseline,
      round.after,
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

    if (error instanceof DelegationChecksFailed) {
      await task.save({ receipts: error.receipts, receiptAttempt: round.progressFile })
      feedback = JSON.stringify({ checks: error.receipts })
    }

    validation.progress.failed(
      {
        revision: round.revision,
        snapshot: snapshotHash(round.after),
        message: error.message,
        receipts: error instanceof DelegationChecksFailed ? error.receipts : undefined,
      },
      round.after,
      error,
    )
    return { kind: 'coordinate', feedback }
  }

  const control = await task.controls()

  if (control.revision !== round.evidence.controlRevision) {
    return {
      kind: 'coordinate',
      feedback: 'Consume all outstanding scoped task updates and submit a fresh result.',
    }
  }

  return { kind: 'accept', round, receipts, revision: control.revision }
}

/** Record the validated snapshot so a later pass on the same base and bytes can reuse it. */
async function acceptRound(
  validation: Validation,
  round: BranchRound,
  receipts: Receipt[],
  revision: number,
): Promise<RepairStep> {
  const { session, base } = validation
  const { task, branch } = session
  const verified = snapshotHash(round.after)

  if (
    snapshotHash(await inventory(branch.workspace)) !== verified ||
    receipts.some((receipt) => receipt.snapshot !== verified)
  ) {
    throw new Error('Branch candidate changed during verification')
  }

  await task.save({ receipts, receiptAttempt: round.progressFile })
  await atomicJson(join(task.directory, `validation-${session.validation}.json`), {
    base,
    snapshot: verified,
    outputPath: round.outputPath,
    receipts,
    controlRevision: revision,
  })
  session.validated = {
    base,
    snapshot: verified,
    evidence: round.evidence,
    validation: session.validation,
  }
  await atomicJson(join(task.directory, 'validated.json'), session.validated)
  return { kind: 'validated', snapshot: verified }
}

/** Commit and push the validated snapshot, then open or update its pull request. */
async function publish(session: BranchSession, snapshot: string): Promise<PublicationStep> {
  const { task, branch } = session
  const { request, plan } = task
  await task.controls()
  await task.save({ status: 'publishing' })
  session.discoveredHead = undefined
  const message = request.task.slice(0, 200).replaceAll('\n', ' ')
  const commit = await publishBranch(
    { ...branch, base: session.lastBase },
    { message, writePaths: request.writePaths, expectedSnapshot: snapshot },
    task.signal,
  )
  await task.save({ commit })
  const pull = await (task.adapters.pullRequest ?? ensureBranchPullRequest)(
    {
      ...branch,
      title: message,
      body:
        `${request.task}\n\nDesign: ${plan.designPath}\n\n` +
        'Autonomous implementation verified with executable checks.\n' +
        `Validation snapshot: ${snapshot}\n`,
    },
    task.signal,
  )
  await task.save({ pullRequest: pull?.url })
  return { kind: 'settle', commit, pull, message }
}

/** Await remote checks, then stop at publication or run the authorized merge queue. Failed
 * remote checks return to validation with their findings. */
async function settle(
  session: BranchSession,
  commit: string,
  pull: GitHubPullRequest | undefined,
  message: string,
): Promise<PublicationStep> {
  const { task } = session

  try {
    await checkRemote(session, pull, commit)
    const mergeRequested = await new Delegations(task.store).locked(async () => {
      const control = await task.controls()

      if (!control.mergeRequested) {
        await task.save({ status: 'published', mergeRequested: false, error: undefined })
      }

      return control.mergeRequested
    })

    if (!mergeRequested) {
      return { kind: 'done' }
    }

    await task.save({ status: 'merge_queued' })
    const authority = await task.controls()

    if (!authority.mergeRequestId) {
      throw new Error('Missing explicit merge authorization receipt')
    }

    const merged = await mergeIntoMain(session, pull, message, authority.mergeRequestId)
    await atomicJson(join(task.directory, 'merged.json'), merged)
    await task.save({
      status: 'complete',
      commit: merged.commit,
      mergeBase: merged.baseTip,
      mergeAttempts: merged.attempts,
      error: undefined,
    })
    return { kind: 'done' }
  } catch (error) {
    if (!(error instanceof GitHubChecksFailed)) {
      throw error
    }

    const feedback = String(error)
    await atomicJson(join(task.directory, `github-failure-${randomUUID()}.json`), {
      error: feedback,
    })
    return { kind: 'validate', feedback }
  }
}

/** Wait for remote checks on a head and confirm no task update arrived after publication. */
async function checkRemote(
  session: BranchSession,
  pull: GitHubPullRequest | undefined,
  head: string,
) {
  const { task } = session
  const prior = session.previousHead
  session.previousHead = head

  if (pull) {
    const receipt = await (task.adapters.checks ?? awaitBranchChecks)(pull, head, task.signal, {
      previousHead: prior,
      excludeAgentReviews: true,
      ...(session.discoveredHead === head ? { registrationGraceMs: 0 } : {}),
    })
    session.discoveredHead = head
    await atomicJson(join(task.directory, `github-${head}.json`), receipt)
  }

  const control = await task.controls()

  if (control.revision !== session.validated?.evidence.controlRevision) {
    throw new Error('Task updates arrived after publication; preserve branch for reconciliation')
  }
}

/** Serialize integration with current main; reviews and checks stay fresh before main moves. */
async function mergeIntoMain(
  session: BranchSession,
  pull: GitHubPullRequest | undefined,
  message: string,
  mergeRequestId: string,
) {
  const { task, branch } = session
  const review = pull
    ? (task.adapters.reviews ?? mergeReviewLoop)(
        join(task.directory, 'agent-reviews.json'),
        mergeRequestId,
        pull,
        task.request.createdAt,
        task.signal,
      )
    : undefined
  return mergeBranch(
    branch,
    {
      message: `Integrate ${message}`,
      writePaths: task.request.writePaths,
      async validate({ baseTip, conflicts }) {
        await task.save({ status: 'merging', mergeBase: baseTip })
        return validateBranch(session, baseTip, conflicts)
      },
      async afterBranchPush({ commit: head, baseTip }) {
        await task.save({ commit: head, mergeBase: baseTip, status: 'merging' })
        await checkRemote(session, pull, head)
        const revised = await review?.(
          head,
          snapshotHash(await inventory(branch.workspace)),
          (findings) => validateBranch(session, baseTip, [], findings),
        )

        // Reviews can wait minutes; CI, human objections and task controls must be fresh.
        if (revised === undefined) {
          await checkRemote(session, pull, head)
        }

        const finalControl = await task.controls()

        if (!finalControl.mergeRequested || finalControl.mergeRequestId !== mergeRequestId) {
          throw new Error('Explicit merge authorization changed during external review')
        }

        return revised
      },
    },
    task.signal,
  )
}
