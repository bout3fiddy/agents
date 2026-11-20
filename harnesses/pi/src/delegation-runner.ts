import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { StateStore, atomicJson, readJson } from './state.ts'
import {
  Delegations,
  delegationDirectory,
  emptyControls,
  type DelegationRequest,
  type DelegationStatus,
  type TaskControls,
} from './delegation-state.ts'
import { createWorkspace, loadProject } from './project.ts'
import { digest, fileHashes, inventory, snapshotHash } from './paths.ts'
import { changes, integrate } from './integration.ts'
import { acquireLock } from './lock.ts'
import { runWorkflow } from './workflow.ts'
import { checkDelegation, DelegationChecksFailed } from './delegation-checks.ts'
import { writeAuditReport } from './recurring-audit.ts'
import { runProgressAuditor } from './progress-auditor.ts'
import { runTaskCoordinator } from './task-coordinator.ts'
import type { Checkpoint } from './contracts.ts'
import { runBranchTask } from './branch-runner.ts'
import { dispatcher } from './dispatch.ts'
import { trackDispatch } from './progress.ts'

async function integrationLock(store: StateStore, signal: AbortSignal) {
  for (let attempt = 0; attempt < 200; attempt++) {
    signal.throwIfAborted()

    try {
      return await acquireLock(join(store.directory, 'workflow.lock'))
    } catch (error) {
      if (!String(error).includes('already running') || attempt === 199) {
        throw error
      }

      await delay(25, undefined, { signal })
    }
  }

  throw new Error('Could not acquire the project integration lock')
}

export function taskScope(request: DelegationRequest): Checkpoint {
  return {
    objective: request.task.slice(0, 2000),
    design: request.context || request.task,
    invariants: ['Preserve unrelated work and the supplied user decisions.'],
    acceptance: ['Complete the assigned task and provide concrete verification evidence.'],
    writePaths: request.writePaths,
    database: false,
    performance: false,
    unresolved: [],
    version: 0,
    hash: digest(JSON.stringify(request)),
    acceptedAt: request.createdAt,
  }
}

export async function runDelegation(
  store: StateStore,
  id: string,
  signal: AbortSignal,
  coordinate = runTaskCoordinator,
): Promise<DelegationStatus> {
  const jobs = new Delegations(store)
  const { request } = await jobs.get(id)

  if (request.kind === 'branch') {
    return runBranchTask(store, request, signal, coordinate)
  }

  const directory = delegationDirectory(store, id)
  let state: DelegationStatus = {
    ...(await readJson<DelegationStatus>(join(directory, 'status.json'))),
    id,
    status: 'running',
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }
  const save = async (update: Partial<DelegationStatus>) => {
    state = {
      ...state,
      ...update,
      ...(update.receipts && { receiptAttempt: state.progressFile ?? 'coordinator.json' }),
      updatedAt: new Date().toISOString(),
    }
    await atomicJson(join(directory, 'status.json'), state)
  }
  const controls = async () =>
    (await readJson<TaskControls>(join(directory, 'controls.json'))) ??
    structuredClone(emptyControls)
  const cancelled = async () => {
    signal.throwIfAborted()

    const control = await controls()

    if (control.cancelled) {
      throw new Error('Task cancelled by user')
    }

    if (control.paused) {
      throw new Error('Task paused for inspection')
    }
  }
  await save({})

  try {
    await cancelled()

    if (request.kind === 'implementation') {
      const checkpoint = await store.checkpoint()

      if (checkpoint?.hash !== request.checkpointHash) {
        throw new Error('Accepted implementation scope changed before background execution')
      }

      const task = await runWorkflow(
        store,
        request.model,
        signal,
        trackDispatch(
          dispatcher(new StateStore(request.root, directory)),
          join(directory, state.progressFile ?? 'coordinator.json'),
        ),
        { ...request.specialistThinking, implementer: request.thinking },
        request.implementerModel,
      )
      const control = await controls()
      await save({
        status:
          task.status === 'complete'
            ? 'complete'
            : control.cancelled
              ? 'cancelled'
              : control.paused
                ? 'paused'
                : 'needs_attention',
        summary: task.evidence.at(-1)?.result.summary,
        error: task.error,
        hostActions: task.hostActions,
        candidate: task.candidate,
        receipts: task.receipts,
        children: task.evidence.map((child) => ({
          role: child.role,
          model: child.model,
          verdict: child.result.verdict,
          ...(child.closedReview && { closedReview: child.closedReview }),
        })),
      })
      return state
    }

    const project = await loadProject(request.root)
    const retained = await readJson<{ workspace: string; originals: string }>(
      join(directory, 'workspace.json'),
    )

    if (retained && state.candidate && state.candidate !== retained.workspace) {
      throw new Error('Retained candidate identity changed; inspect before resuming')
    }

    const workspace = retained?.workspace ?? (await createWorkspace(request.root))
    const originals = retained?.originals ?? (await createWorkspace(workspace))
    const before = await inventory(originals)

    if (
      retained &&
      digest(JSON.stringify(fileHashes(before))) !==
        digest(JSON.stringify(await readJson(join(directory, 'baseline.json'))))
    ) {
      throw new Error('Retained original snapshot changed; inspect before resuming')
    }

    await save({ candidate: workspace })
    await atomicJson(join(directory, 'baseline.json'), fileHashes(before))
    await atomicJson(join(directory, 'workspace.json'), { workspace, originals })
    const audit = request.recurring?.audit ? request.recurring : undefined
    const execute = audit?.model === 'fable' ? runProgressAuditor : coordinate
    const evidence = await execute(
      {
        task: request.task,
        context: request.context,
        kind: request.kind,
        implementerModel: request.implementerModel,
        decideContinuation: Boolean(audit?.stopWhen),
        thinking: request.thinking,
        workspace,
        project,
        checkpoint: taskScope(request),
        model: request.model,
        outputPath: join(directory, state.progressFile ?? 'coordinator.json'),
        baseline: fileHashes(before),
        originals,
        controlsPath: join(directory, 'controls.json'),
        review: request.review,
        resumed: (state.deliveryVersion ?? 0) > 0,
      },
      signal,
    )
    await atomicJson(join(directory, 'evidence.json'), evidence)
    await cancelled()
    const after = await inventory(workspace)
    await save({
      status: 'checking',
      summary: evidence.result.summary,
      changedPaths: changes(before, after),
      children: evidence.children.map((child) => ({
        role: child.role,
        model: child.model,
        verdict: child.result.verdict,
        ...(child.closedReview && { closedReview: child.closedReview }),
      })),
      hostActions:
        evidence.result.hostActions ??
        evidence.children
          .filter((child) => evidence.result.verdict !== 'pass' || child.result.verdict === 'pass')
          .flatMap((child) => child.result.hostActions ?? []),
    })

    if (audit && (request.kind !== 'research' || state.changedPaths?.length)) {
      throw new Error('A recurring audit requires a read-only research worker')
    }

    const receipts = await checkDelegation(
      request,
      workspace,
      project,
      before,
      after,
      evidence,
      signal,
    )
    await save({ receipts })
    const verified = snapshotHash(after)

    if (
      snapshotHash(await inventory(workspace)) !== verified ||
      receipts.some((receipt) => receipt.snapshot !== verified)
    ) {
      throw new Error('Candidate or check snapshot changed during task verification')
    }

    // Serialize application with implementation workflows; never replace a pending journal.
    const release = state.changedPaths?.length ? await integrationLock(store, signal) : undefined

    try {
      await jobs.locked(async () => {
        release?.assertHeld()
        await cancelled()

        if ((await controls()).revision !== evidence.controlRevision) {
          throw new Error('A late task update was not consumed; candidate retained for follow-up')
        }

        if (
          request.kind === 'maintenance' &&
          state.changedPaths?.length &&
          snapshotHash(await inventory(request.root)) !== snapshotHash(before)
        ) {
          throw new Error('Project changed during code maintenance; preserve candidate and rerun')
        }

        const journal = state.changedPaths?.length
          ? await readJson<{ status: string }>(join(store.directory, 'integration.json'))
          : undefined

        if (journal?.status === 'pending') {
          throw new Error('A pending integration requires recovery before this task can apply')
        }

        if (state.changedPaths?.length) {
          await save({ status: 'applying' })
          await integrate(store, before, after, request.writePaths)
        }

        if (audit) {
          const report = await writeAuditReport(
            request,
            evidence.result,
            evidence.model,
            evidence.thinking,
          )

          if (evidence.result.verdict === 'blocked') {
            await save(report)
            throw new Error('Auditor reported blocked: ' + evidence.result.summary)
          }

          await save({ ...report, status: 'complete' })
        } else {
          await save({ status: 'complete' })
        }
      })
    } finally {
      await release?.()
    }

    // Keep receipts and failed candidates; successful snapshots are already in the project.
    try {
      await rm(workspace, { recursive: true, force: true })
      await rm(originals, { recursive: true, force: true })
      await save({ candidate: undefined })
    } catch (error) {
      await save({
        error: `Applied successfully; temporary workspace cleanup failed: ${String(error)}`,
      })
    }
  } catch (error) {
    const control = await controls()
    await save({
      status: control.cancelled ? 'cancelled' : control.paused ? 'paused' : 'needs_attention',
      error: String(error),
      ...(error instanceof DelegationChecksFailed ? { receipts: error.receipts } : {}),
    })
  }

  return state
}

async function main(): Promise<void> {
  const path = process.argv[3]

  if (!path) {
    throw new Error('Expected --task REQUEST_PATH')
  }

  const request = await readJson<DelegationRequest>(path)

  if (!request || process.argv[2] !== '--task') {
    throw new Error('Expected --task REQUEST_PATH')
  }

  const store = new StateStore(request.root)

  if (path !== join(delegationDirectory(store, request.id), 'request.json')) {
    throw new Error('Task request must be in the project delegation directory')
  }

  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Task supervisor terminated'))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let polling = false
  const poll = setInterval(async () => {
    if (polling) {
      return
    }

    polling = true

    try {
      const control = await readJson<TaskControls>(
        join(delegationDirectory(store, request.id), 'controls.json'),
      )

      if (control?.cancelled) {
        controller.abort(new Error('Task cancelled by user'))
      }

      if (control?.paused) {
        controller.abort(new Error('Task paused for inspection'))
      }
    } catch (error) {
      controller.abort(error)
    } finally {
      polling = false
    }
  }, 300)

  try {
    await runDelegation(store, request.id, controller.signal)
  } finally {
    clearInterval(poll)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
