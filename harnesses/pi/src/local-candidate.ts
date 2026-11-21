import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { linkBranchDependencies } from './branch-runner.ts'
import { childSummary } from './context.ts'
import type { Checkpoint, Receipt, WorkerEvidence } from './contracts.ts'
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
import { digest, fileHashes, inventory, matches, snapshotHash } from './paths.ts'
import { trackDispatch } from './progress.ts'
import { loadPinnedProject } from './pinned-project.ts'
import { atomicJson, readJson, StateStore } from './state.ts'

async function localProject(request: DelegationRequest, signal: AbortSignal) {
  const project = await loadPinnedProject(request.root, request.local!.base, signal)
  const acceptance = request.local!.acceptance

  if (project.checks.some((check) => check.id === acceptance.id)) {
    throw new Error('The pinned project already declares the reserved local acceptance check')
  }

  return { ...project, root: request.root, checks: [...project.checks, acceptance] }
}

/** Use the original workload and project configuration even on a later integration target. */
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

    for (const arg of plan.acceptance.argv) {
      const path = arg.replace(/^\.\//, '')

      if (policy.has(path)) {
        workload.add(path)
      }
    }

    if (['npm', 'bun', 'pnpm', 'yarn'].includes(plan.acceptance.argv[0]!)) {
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

async function executeLocalCandidate(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  directory: string,
  lock: ReleaseLock,
  dispatch?: Dispatcher,
): Promise<DelegationStatus> {
  const statusPath = join(directory, 'status.json')
  const controlsPath = join(directory, 'controls.json')
  let state = (await readJson<DelegationStatus>(statusPath))!
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

  let originals: string | undefined
  let linkedOriginalDependencies = false

  try {
    const local = request.local

    if (!local || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(local.base)) {
      throw new Error('Missing local candidate or invalid pinned commit')
    }

    await controls()

    if (state.status === 'complete') {
      return state
    }

    await save({ status: 'running', pid: process.pid, hostActions: undefined, error: undefined })
    const branch = await checkoutCandidate(store, request, signal)
    await save({ candidate: branch.workspace, branch: branch.branch, base: local.base })
    const preparedPath = join(directory, 'local-commit.json')
    const prepared = await readJson<PreparedCommit>(preparedPath)
    let initialHead = await checkRecordedHead(branch, prepared, signal)

    if (prepared && (await controls()).revision === prepared.revision) {
      const evidence = await readJson<WorkerEvidence>(join(directory, prepared.progressFile))
      const files = await inventory(branch.workspace)

      if (
        evidence?.role !== 'implementer' ||
        evidence.result.verdict !== 'pass' ||
        evidence.snapshot !== prepared.snapshot ||
        snapshotHash(files) !== prepared.snapshot ||
        !prepared.receipts.some((r) => r.check === local.acceptance.id && r.status === 'passed') ||
        prepared.receipts.some((r) => r.snapshot !== prepared.snapshot)
      ) {
        throw new Error('Retained candidate no longer matches its verified evidence')
      }

      const commit = await commitVerifiedTree(
        branch,
        {
          message: request.task.slice(0, 200).replaceAll('\n', ' '),
          writePaths: request.writePaths,
          expectedSnapshot: prepared.snapshot,
        },
        branch.base,
        signal,
        async (tree) => {
          if (tree !== prepared.tree) {
            throw new Error('Retained candidate index differs from its verified tree')
          }
        },
      )
      initialHead = commit
      const recovered = await finish(prepared.revision, {
        commit,
        receipts: prepared.receipts,
        children: [childSummary(evidence)],
        progressFile: prepared.progressFile,
        receiptAttempt: prepared.progressFile,
        summary: evidence.result.summary,
        error: undefined,
      })

      if (recovered) {
        return state
      }
    }

    await mkdir(join(store.directory, 'baselines'), { recursive: true, mode: 0o700 })
    const basePath = join(store.directory, 'baselines', randomUUID())
    await gitCommand(
      request.root,
      ['worktree', 'add', '--detach', '--', basePath, local.base],
      signal,
    )
    originals = basePath
    linkedOriginalDependencies = await linkBranchDependencies(request.root, basePath, signal)
    const project = await localProject(request, signal)
    const before = await inventory(basePath)
    const baseline = fileHashes(before)
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
    let feedback = ''
    const failures = new Set<string>()

    while (true) {
      const current = await controls()
      const progressFile = `implementer-${randomUUID()}.json`
      const output = join(directory, progressFile)
      await save({
        status: 'running',
        progressFile,
        receipts: undefined,
        receiptAttempt: undefined,
      })
      const child = trackDispatch(
        dispatch ?? dispatcher(new StateStore(request.root, directory)),
        output,
      )
      const evidence = await child(
        {
          role: 'implementer',
          thinking: request.thinking,
          implementerModel: request.implementerModel,
          task: JSON.stringify({
            task: request.task,
            updates: current.messages,
            feedback,
            previousHostHandoff: current.previousHostHandoff,
          }),
          model: request.model,
          workspace: branch.workspace,
          project,
          checkpoint,
          baseline,
          originals,
        },
        signal,
      )
      await atomicJson(output, evidence)
      await controls()
      const after = await inventory(branch.workspace)
      const snapshot = snapshotHash(after)
      await save({
        summary: evidence.result.summary,
        status: 'checking',
        children: [...(state.children ?? []), childSummary(evidence)],
        changedPaths: changes(before, after),
        hostActions: evidence.result.hostActions,
      })

      if (
        evidence.role !== 'implementer' ||
        evidence.result.verdict !== 'pass' ||
        evidence.snapshot !== snapshot
      ) {
        throw new Error(`Local implementer ${evidence.result.verdict}: ${evidence.result.summary}`)
      }

      let receipts

      try {
        receipts = await verifyLocalSnapshot(request, basePath, branch.workspace, evidence, signal)
      } catch (error) {
        if (
          !(error instanceof DelegationChecksFailed) &&
          !(error instanceof DelegationRepairRequired)
        ) {
          throw error
        }

        if (error instanceof DelegationChecksFailed) {
          await save({ receipts: error.receipts, receiptAttempt: progressFile })
          const failed = error.receipts.filter((r) => r.status !== 'passed')

          if (failed.some((r) => r.inheritedLintPaths?.length || r.status === 'unavailable')) {
            throw error
          }

          feedback = JSON.stringify(
            failed.map((r) => ({
              check: r.check,
              status: r.status,
              output: r.result.output.slice(-4000),
            })),
          )
        } else {
          feedback = error.message
        }

        const failure = `${current.revision}/${snapshot}/${error.message}`

        if (failures.has(failure)) {
          throw new Error(`Repair made no progress on the same local candidate: ${error.message}`, {
            cause: error,
          })
        }

        failures.add(failure)
        continue
      }

      await save({ receipts, receiptAttempt: progressFile })

      if ((await controls()).revision !== current.revision) {
        feedback = 'Read the newly received scoped guidance and verify the candidate again.'
        continue
      }

      if ((await currentCommit(branch, signal)) !== initialHead) {
        throw new Error('Candidate branch HEAD changed during verification')
      }

      const commit = await commitVerifiedTree(
        branch,
        {
          message: request.task.slice(0, 200).replaceAll('\n', ' '),
          writePaths: request.writePaths,
          expectedSnapshot: snapshot,
        },
        branch.base,
        signal,
        (tree) =>
          atomicJson(preparedPath, {
            parent: initialHead,
            tree,
            snapshot,
            revision: current.revision,
            progressFile,
            receipts,
          } satisfies PreparedCommit),
      )
      initialHead = commit
      const accepted = await finish(current.revision, { commit })

      if (accepted) {
        return state
      }

      feedback = 'Read the newly received scoped guidance and verify the candidate again.'
    }
  } catch (error) {
    const control = await readJson<TaskControls>(controlsPath)
    await save({
      status: control?.paused
        ? 'paused'
        : signal.aborted || control?.cancelled
          ? 'cancelled'
          : 'needs_attention',
      error: String(error),
    })
    return state
  } finally {
    if (originals) {
      if (linkedOriginalDependencies) {
        await rm(join(originals, 'node_modules'), { force: true })
      }

      await gitCommand(request.root, ['worktree', 'remove', '--', originals])
    }
  }
}
