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
import { ensureBranchPullRequest, awaitBranchChecks, GitHubChecksFailed } from './branch-github.ts'
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
import { validateDesign } from './contracts.ts'
import { mergeReviewLoop } from './merge-reviews.ts'

export type BranchAdapters = {
  pullRequest: typeof ensureBranchPullRequest
  checks: typeof awaitBranchChecks
  reviews: typeof mergeReviewLoop
}

async function dependencies(root: string, workspace: string, signal: AbortSignal) {
  let modules: string

  try {
    modules = await realpath(join(root, 'node_modules'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }

  // Dependency links must be ignored by the committed repository policy before host setup.
  await gitCommand(workspace, ['check-ignore', '-q', 'node_modules/'], signal)
  await symlink(modules, join(workspace, 'node_modules'))
}

export async function runBranchTask(
  store: StateStore,
  request: DelegationRequest,
  signal: AbortSignal,
  coordinate = runTaskCoordinator,
  adapters: Partial<BranchAdapters> = {},
): Promise<DelegationStatus> {
  const directory = delegationDirectory(store, request.id)
  let state: DelegationStatus = {
    ...(await readJson<DelegationStatus>(join(directory, 'status.json'))),
    id: request.id,
    status: 'running',
    hostActions: undefined,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }
  let blockedActions: DelegationStatus['hostActions']
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

  try {
    const plan = request.branch

    if (!plan || request.kind !== 'branch') {
      throw new Error('Missing independent branch design')
    }

    validateDesign(plan.design)

    const referenced =
      plan.design.design === pinnedDesignInstruction(plan.designPath, plan.designHash)

    if (
      plan.design.unresolved.length ||
      (!referenced && digest(plan.design.design) !== plan.designHash)
    ) {
      throw new Error('The pinned branch design is unresolved or changed')
    }

    await controls()
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

    await save({ branch: branch.branch, base: branch.base, candidate: branch.workspace })
    await atomicJson(join(directory, 'branch.json'), branch)

    if (!retained) {
      await dependencies(request.root, branch.workspace, signal)
    }

    let validated = await readJson<{
      base: string
      snapshot: string
      evidence: TaskCoordinatorEvidence
      validation: number
    }>(join(directory, 'validated.json'))
    let validation = validated?.validation ?? 0
    let lastBase = state.mergeBase ?? branch.base
    const children: NonNullable<DelegationStatus['children']> = state.children ?? []
    let previousHead = state.commit

    async function validate(base: string, conflicts: string[], feedback = ''): Promise<string> {
      const current = await controls()
      const snapshot = snapshotHash(await inventory(branch.workspace))

      if (
        !feedback &&
        !conflicts.length &&
        validated?.base === base &&
        validated.snapshot === snapshot &&
        validated.evidence.controlRevision === current.revision
      ) {
        return snapshot
      }

      validation++
      lastBase = base
      const originals = join(store.directory, 'baselines', `${request.id}-${randomUUID()}`)
      await mkdir(join(store.directory, 'baselines'), { recursive: true, mode: 0o700 })
      await prepareBaseline(branch, base, originals, signal)
      const baseline = await inventory(originals)
      const document = (await readBoundedFile(await safePath(originals, plan!.designPath)))
        .toString('utf8')
        .trimEnd()

      if (digest(document) !== plan!.designHash) {
        throw new Error('The design document changed on main; retained branch needs reconciliation')
      }

      const project = { ...(await loadProject(originals)), root: request.root }
      requireBranchChecks(project, plan!.design)

      const checkpoint = {
        ...plan!.design,
        version: 1,
        hash: digest(JSON.stringify(plan!.design)),
        acceptedAt: request.createdAt,
      }
      let revision = 0

      // Design authority already came from the parent. Review/check repair has no call ceiling.
      while (true) {
        await controls()
        revision++
        await save({ status: 'running', mergeBase: base, error: undefined })
        const generation = state.deliveryVersion ? `-run-${state.deliveryVersion}` : ''
        const progressFile = `orchestrator-${validation}-${revision}${generation}.json`
        const outputPath = join(directory, progressFile)
        await save({ progressFile, receipts: undefined, receiptAttempt: undefined })
        const evidence = await coordinate(
          {
            kind: 'branch',
            designPath: plan!.designPath,
            thinking: request.thinking,
            implementerModel: request.implementerModel,
            task: request.task,
            workspace: branch.workspace,
            project,
            checkpoint,
            context: JSON.stringify({
              designPath: plan!.designPath,
              design: plan!.design.design,
              instruction:
                'Execute autonomously from this settled design. Resolve test and reviewer ' +
                'feedback yourself. Preserve other tasks. Do not request routine human approval.',
              phase: validation === 1 && !retained ? 'implementation' : 'integration revalidation',
              baseCommit: base,
              conflicts,
              previousFeedback: feedback,
              ...(current.previousHostHandoff &&
                current.previousHostHandoff.forDeliveryVersion === state.deliveryVersion && {
                  previousHostHandoff: {
                    attempt: current.previousHostHandoff.attempt,
                    actions: current.previousHostHandoff.actions,
                  },
                }),
              parentContext: request.context,
            }),
            model: request.model,
            outputPath,
            originals,
            baseline: fileHashes(baseline),
            controlsPath: join(directory, 'controls.json'),
            resumed: (state.deliveryVersion ?? 0) > 0,
          },
          signal,
        )
        await atomicJson(outputPath, evidence)
        children.push(...evidence.children.map(childSummary))
        await save({ children, summary: evidence.result.summary, status: 'checking' })

        if (evidence.result.verdict === 'blocked') {
          blockedActions = evidence.result.hostActions
          throw new Error(`Autonomous orchestrator blocked: ${evidence.result.summary}`)
        }

        if (evidence.result.verdict !== 'pass') {
          feedback = JSON.stringify(evidence.result)
          continue
        }

        const after = await inventory(branch.workspace)
        await save({ changedPaths: changes(baseline, after) })
        let receipts

        try {
          receipts = await checkDelegation(
            { ...request, root: originals },
            branch.workspace,
            project,
            baseline,
            after,
            evidence,
            signal,
          )
        } catch (error) {
          if (
            !(error instanceof DelegationChecksFailed) &&
            !(error instanceof DelegationRepairRequired)
          ) {
            throw error
          }

          if (error instanceof DelegationChecksFailed) {
            await save({ receipts: error.receipts, receiptAttempt: progressFile })
            feedback = JSON.stringify({ checks: error.receipts })
          } else {
            feedback = error.message
          }

          continue
        }

        const control = await controls()

        if (control.revision !== evidence.controlRevision) {
          feedback = 'Consume all outstanding scoped task updates and submit a fresh result.'
          continue
        }

        const verified = snapshotHash(after)

        if (
          snapshotHash(await inventory(branch.workspace)) !== verified ||
          receipts.some((receipt) => receipt.snapshot !== verified)
        ) {
          throw new Error('Branch candidate changed during verification')
        }

        await save({ receipts, receiptAttempt: progressFile })
        await atomicJson(join(directory, `validation-${validation}.json`), {
          base,
          snapshot: verified,
          outputPath,
          receipts,
          controlRevision: control.revision,
        })
        validated = { base, snapshot: verified, evidence, validation }
        await atomicJson(join(directory, 'validated.json'), validated)
        await gitCommand(request.root, ['worktree', 'remove', '--', originals], signal)
        return verified
      }
    }

    let feedback = ''

    while (true) {
      const snapshot = await validate(lastBase, [], feedback)
      await controls()
      await save({ status: 'publishing' })
      const message = request.task.slice(0, 200).replaceAll('\n', ' ')
      const commit = await publishBranch(
        { ...branch, base: lastBase },
        {
          message,
          writePaths: request.writePaths,
          expectedSnapshot: snapshot,
        },
        signal,
      )
      await save({ commit })
      const pull = await (adapters.pullRequest ?? ensureBranchPullRequest)(
        {
          ...branch,
          title: message,
          body:
            `${request.task}\n\nDesign: ${plan.designPath}\n\n` +
            'Autonomous implementation with independent specialist review and executable tests.\n' +
            `Validation snapshot: ${snapshot}\n`,
        },
        signal,
      )
      await save({ pullRequest: pull?.url })

      let discoveredHead: string | undefined

      async function checkRemote(head: string) {
        const prior = previousHead
        previousHead = head

        if (pull) {
          const receipt = await (adapters.checks ?? awaitBranchChecks)(pull, head, signal, {
            previousHead: prior,
            excludeAgentReviews: true,
            ...(discoveredHead === head ? { registrationGraceMs: 0 } : {}),
          })
          discoveredHead = head
          await atomicJson(join(directory, `github-${head}.json`), receipt)
        }

        const control = await controls()

        if (control.revision !== validated?.evidence.controlRevision) {
          throw new Error(
            'Task updates arrived after publication; preserve branch for reconciliation',
          )
        }
      }

      try {
        await checkRemote(commit)
        const mergeRequested = await new Delegations(store).locked(async () => {
          const control = await controls()

          if (!control.mergeRequested) {
            await save({ status: 'published', mergeRequested: false, error: undefined })
          }

          return control.mergeRequested
        })

        if (!mergeRequested) {
          return state
        }

        await save({ status: 'merge_queued' })
        const authority = await controls()

        if (!authority.mergeRequestId) {
          throw new Error('Missing explicit merge authorization receipt')
        }

        const review = pull
          ? (adapters.reviews ?? mergeReviewLoop)(
              join(directory, 'agent-reviews.json'),
              authority.mergeRequestId,
              pull,
              request.createdAt,
              signal,
            )
          : undefined
        const merged = await mergeBranch(
          branch,
          {
            message: `Integrate ${message}`,
            writePaths: request.writePaths,
            async validate({ baseTip, conflicts }) {
              await save({ status: 'merging', mergeBase: baseTip })
              return validate(baseTip, conflicts)
            },
            async afterBranchPush({ commit: head, baseTip }) {
              await save({ commit: head, mergeBase: baseTip, status: 'merging' })
              await checkRemote(head)
              const revised = await review?.(
                head,
                snapshotHash(await inventory(branch.workspace)),
                (findings) => validate(baseTip, [], findings),
              )

              // Reviews can wait minutes; CI, human objections and task controls must be fresh.
              if (revised === undefined) {
                await checkRemote(head)
              }

              const finalControl = await controls()

              if (
                !finalControl.mergeRequested ||
                finalControl.mergeRequestId !== authority.mergeRequestId
              ) {
                throw new Error('Explicit merge authorization changed during external review')
              }

              return revised
            },
          },
          signal,
        )
        await atomicJson(join(directory, 'merged.json'), merged)
        await save({
          status: 'complete',
          commit: merged.commit,
          mergeBase: merged.baseTip,
          mergeAttempts: merged.attempts,
          error: undefined,
        })
        return state
      } catch (error) {
        if (!(error instanceof GitHubChecksFailed)) {
          throw error
        }

        feedback = String(error)
        await atomicJson(join(directory, `github-failure-${randomUUID()}.json`), {
          error: feedback,
        })
      }
    }
  } catch (error) {
    const control = await readJson<TaskControls>(join(directory, 'controls.json'))
    await save({
      status: control?.paused
        ? 'paused'
        : signal.aborted || control?.cancelled
          ? 'cancelled'
          : 'needs_attention',
      hostActions:
        control?.paused || signal.aborted || control?.cancelled ? undefined : blockedActions,
      error: String(error),
    })
    return state
  }
}
