import { realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Type } from 'typebox'
import type {
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { StateStore } from './state.ts'
import { textResult } from './file-tools.ts'
import { digest } from './paths.ts'
import { launchDelegation } from './delegation-process.ts'
import {
  Delegations,
  activeTask,
  ownsTaskPaths,
  delegateSchema,
  delegationView,
  scopesOverlap,
  type DelegateInput,
  type Delegation,
  type DelegationRequest,
} from './delegation-state.ts'
import { revisionSchema, reviseTasks } from './task-recovery.ts'

type Launcher = (request: DelegationRequest) => Promise<void>
const idSchema = Type.String({ minLength: 36, maxLength: 36 })
const storeFor = async (cwd: string) => new StateStore(await realpath(cwd))

async function destination(cwd: string, path: string): Promise<string> {
  let current = resolve(cwd, path)
  const missing: string[] = []

  for (let depth = 0; depth < 100; depth++) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) {
        throw error
      }

      missing.unshift(basename(current))
      current = dirname(current)
    }
  }

  throw new Error('Write destination exceeds the directory depth limit')
}

function messageIds(details: unknown): string[] {
  const value = details as { taskId?: string; taskIds?: string[] } | undefined
  return value?.taskIds ?? (value?.taskId ? [value.taskId] : [])
}

const notificationId = (job: Delegation) =>
  job.state.deliveryVersion ? `${job.request.id}:${job.state.deliveryVersion}` : job.request.id

function taskMilestone(job: Delegation) {
  const { status, commit, branch } = job.state

  if (branch && commit && (status === 'merge_queued' || status === 'merging')) {
    return { key: 'merge-queue', summary: `Published ${branch} at ${commit}. Integration pending.` }
  }

  const summary = job.milestone
  return summary ? { key: digest(summary), summary } : undefined
}

function resultMessage(jobs: Delegation[]): CustomMessageEntryDraft {
  return {
    type: 'custom_message',
    customType: 'pi-task-result',
    display: false,
    content:
      'Background task outcome. Handle routine completions privately. ' +
      'When an outcome changes what the user can use, decide or expect, combine related ' +
      'results into one short update. Answer pending questions first. ' +
      'For failures, inspect the retained candidate and evidence. ' +
      'Recover within the original authorized scope: handle host-only operations on the host, ' +
      'preserve useful work and rerun relevant checks. Do not repeat a worker lacking the needed ' +
      'capability or expand permission. Paused work is preserved: inspect, revise and resume it ' +
      'when consistent with user instructions. Never restart user-cancelled work without a new ' +
      'request. Report genuine external blockers.\n' +
      JSON.stringify(jobs.map(delegationView)),
    details: { taskIds: jobs.map(notificationId) },
  }
}

export function registerDelegation(pi: ExtensionAPI, launch: Launcher = launchDelegation) {
  pi.registerMessageRenderer('pi-task-progress', () => ({ render: () => [], invalidate() {} }))
  let current: ExtensionContext | undefined
  let closed = false
  let collecting = false
  const delivered = new Set<string>()
  const collect = async (ctx: ExtensionContext): Promise<CustomMessageEntryDraft[]> => {
    if (closed || collecting) {
      return []
    }

    collecting = true

    try {
      const session = ctx.sessionManager.getSessionId()
      const jobs = await new Delegations(await storeFor(ctx.cwd)).list()

      if (closed || session !== ctx.sessionManager.getSessionId()) {
        return []
      }

      ctx.ui.setStatus(
        'pi-tasks',
        jobs.some((job) => activeTask(job.state))
          ? 'Tasks · ' +
              jobs
                .filter((job) => activeTask(job.state))
                .map((job) => {
                  const progress = job.state.progress
                  return (
                    `${job.request.id.slice(0, 6)} ${progress?.role ?? job.state.status}/` +
                    `${progress?.child?.tool ?? progress?.stage ?? 'starting'}`
                  )
                })
                .join(' · ')
          : undefined,
      )
      const entries = ctx.sessionManager.getEntries()
      const branch = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id))
      const persisted = new Set(
        entries.flatMap((entry) =>
          entry.type === 'custom_message' &&
          ['pi-task-result', 'pi-task-progress', 'pi-task-attention', 'pi-task-milestone'].includes(
            entry.customType,
          )
            ? messageIds(entry.details)
            : [],
        ),
      )
      const ready = jobs.filter(
        (job) =>
          !activeTask(job.state) &&
          !(
            job.request.recurring?.audit &&
            (job.state.status === 'cancelled' ||
              (job.state.status === 'complete' && job.state.auditAttention === false))
          ) &&
          job.request.session === session &&
          (!job.request.originEntry || branch.has(job.request.originEntry)) &&
          !persisted.has(notificationId(job)) &&
          !delivered.has(`${session}:${notificationId(job)}`),
      )

      for (const job of ready) {
        delivered.add(`${session}:${notificationId(job)}`)
      }

      const messages: CustomMessageEntryDraft[] = ready.length ? [resultMessage(ready)] : []

      const milestones: { id: string; task: string; summary: string }[] = []

      for (const job of jobs.filter(
        (item) =>
          activeTask(item.state) &&
          !item.request.recurring?.audit &&
          item.request.session === session &&
          (!item.request.originEntry || branch.has(item.request.originEntry)),
      )) {
        const milestone = taskMilestone(job)

        if (milestone) {
          const id = `${job.request.id}:milestone:${milestone.key}`

          if (!persisted.has(id) && !delivered.has(`${session}:${id}`)) {
            milestones.push({
              id,
              task: job.request.task.slice(0, 160),
              summary: milestone.summary,
            })
          }
        }

        const progress = job.state.progress
        const activity = progress?.child?.updatedAt ?? progress?.updatedAt ?? job.state.updatedAt
        const attention = job.state.health === 'quiet'
        const id = `${job.request.id}:${attention ? 'attention' : 'progress'}:${activity}`
        const previous = entries.findLast(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'pi-task-progress' &&
            (entry.details as { taskId?: string })?.taskId === job.request.id,
        )
        const since = previous?.timestamp ?? job.request.createdAt

        if (
          (!attention && Date.now() - Date.parse(since) < 60000) ||
          persisted.has(id) ||
          delivered.has(`${session}:${id}`)
        ) {
          continue
        }

        delivered.add(`${session}:${id}`)
        messages.push({
          type: 'custom_message',
          customType: attention ? 'pi-task-attention' : 'pi-task-progress',
          display: false,
          content:
            (attention
              ? 'Task has no recorded activity for three minutes. Inspect status and traces; ' +
                'distinguish a provider wait from failure. Recover authorized work; ' +
                'do not cancel or restart solely because of elapsed time.\n'
              : 'Background progress. Continue discussion; no acknowledgement needed.\n') +
            JSON.stringify({
              id: job.request.id,
              task: job.request.task.slice(0, 160),
              progress,
              activityAgeMs: job.state.activityAgeMs,
            }),
          details: { taskIds: [id], taskId: job.request.id },
        })
      }

      if (milestones.length) {
        const previous = entries.findLast(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'pi-task-milestone' &&
            branch.has(entry.id),
        )
        const waking = messages.some((message) => message.customType !== 'pi-task-progress')

        if (!previous || waking || Date.now() - Date.parse(previous.timestamp) >= 60000) {
          const taskIds = milestones.map(({ id }) => id)

          for (const id of taskIds) {
            delivered.add(`${session}:${id}`)
          }

          messages.push({
            type: 'custom_message',
            customType: 'pi-task-milestone',
            display: false,
            content:
              'Assess these milestones against what the user already knows. ' +
              'If anything changes what they can use, decide or expect, give one brief update ' +
              'with the evidence and its impact. Handle routine or repeated facts privately. ' +
              'Combine concurrent outcomes and answer pending user questions first.\n' +
              JSON.stringify(milestones.map(({ task, summary }) => ({ task, summary }))),
            details: { taskIds },
          })
        }
      }

      return messages
    } finally {
      collecting = false
    }
  }
  const idle = async (ctx: ExtensionContext) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return
    }

    const messages = await collect(ctx)

    if (closed || !ctx.isIdle() || ctx.hasPendingMessages()) {
      for (const message of messages) {
        for (const id of messageIds(message.details)) {
          delivered.delete(`${ctx.sessionManager.getSessionId()}:${id}`)
        }
      }

      return
    }

    const wake = messages.findLast((message) => message.customType !== 'pi-task-progress')

    for (const message of messages) {
      if (message !== wake) {
        pi.sendMessage(message, { triggerTurn: false, deliverAs: 'followUp' })
      }
    }

    if (wake) {
      pi.sendMessage(wake, { triggerTurn: true, deliverAs: 'followUp' })
    }
  }
  const boundary = async (event: BoundaryState, ctx: ExtensionContext) => {
    if (event.outcome !== 'completed') {
      return
    }

    const messages = await collect(ctx)
    return messages.length
      ? {
          entries: [...event.entries, ...messages],
          ...(event.context.pendingMessages.length ||
          messages.every((message) => message.customType === 'pi-task-progress')
            ? {}
            : { continue: true }),
        }
      : undefined
  }
  pi.on('turn_end', boundary)
  pi.on('agent_before_settle', boundary)
  pi.on('agent_settled', async (_event, ctx) => idle(ctx))
  pi.on('session_start', (_event, ctx) => {
    closed = false
    current = ctx
  })
  pi.on('before_agent_start', async (_event, ctx) => {
    current = ctx
    const active = (await new Delegations(await storeFor(ctx.cwd)).list()).filter((job) =>
      ownsTaskPaths(job.state),
    )

    if (active.length) {
      return {
        message: {
          customType: 'pi-active-tasks',
          display: false,
          content:
            'Active or paused tasks; continue discussion and preserve their owned paths.\n' +
            JSON.stringify(active.map(delegationView)),
        },
      }
    }

    return undefined
  })
  const timer = setInterval(() => {
    if (current && !closed) {
      void idle(current).catch((error: unknown) => {
        closed = true
        clearInterval(timer)

        try {
          current?.ui.setStatus(
            'pi-tasks',
            `Task observer stopped; reload to resume: ${String(error).slice(0, 120)}`,
          )
        } catch {
          // SDK disposal can invalidate a context without emitting session_shutdown.
        }
      })
    }
  }, 1000)
  timer.unref()
  pi.on('session_shutdown', () => {
    closed = true
    clearInterval(timer)
  })
  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as { path?: string; paths?: string[]; format?: boolean }
    const paths =
      ['write', 'edit'].includes(event.toolName) && input.path
        ? [input.path]
        : event.toolName === 'document_check' && input.format
          ? (input.paths ?? [])
          : []

    if (!paths.length) {
      return
    }

    const store = await storeFor(ctx.cwd)
    const names = await Promise.all(
      paths.map(async (path) => relative(store.projectRoot, await destination(ctx.cwd, path))),
    )

    for (const job of await new Delegations(store).list()) {
      if (
        job.request.kind !== 'branch' &&
        ownsTaskPaths(job.state) &&
        scopesOverlap(names, job.request.writePaths)
      ) {
        return {
          block: true,
          reason:
            `Task ${job.request.id} owns these files. ` +
            'Use task_control to steer or pause, then revise_tasks to reassign ownership.',
        }
      }
    }

    return undefined
  })

  async function start(ctx: ExtensionContext, input: DelegateInput) {
    if (!ctx.model) {
      throw new Error('Select a model first')
    }

    const jobs = new Delegations(await storeFor(ctx.cwd))
    const job = await jobs.start(
      input,
      {
        session: ctx.sessionManager.getSessionId(),
        originEntry: ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
        model: `${ctx.model.provider}/${ctx.model.id}`,
      },
      launch,
    )
    return textResult({
      ...delegationView(job),
      next: 'Continue the conversation. Completion arrives automatically; do not poll or wait.',
    })
  }

  pi.registerTool({
    name: 'delegate_task',
    label: 'Delegate background task',
    description:
      'Start a background coordinator that can delegate workers and specialist reviews. ' +
      'Use for substantial implementation, explicit delegation or work that would disrupt the ' +
      'current discussion. Routine setup and related small work may stay on the host. Workers ' +
      'cannot install dependencies, use the network or publish Git; declare host requirements. ' +
      'Return immediately and continue discussion. Supply context and scoped writePaths. ' +
      'For implementation, include the settled design; omit design only when resuming its scope.',
    parameters: delegateSchema,
    async execute(_id, args, _signal, _update, ctx) {
      return start(ctx, args)
    },
  })
  pi.registerTool({
    name: 'task_status',
    label: 'Inspect background tasks',
    description:
      'Inspect saved task status/evidence when needed. Completion arrives automatically.',
    parameters: Type.Object({ id: Type.Optional(idSchema) }),
    async execute(_id, args, _signal, _update, ctx) {
      const jobs = new Delegations(await storeFor(ctx.cwd))
      return textResult(
        args.id ? delegationView(await jobs.get(args.id)) : (await jobs.list()).map(delegationView),
      )
    },
  })
  pi.registerTool({
    name: 'task_control',
    label: 'Steer, pause or cancel task',
    description:
      'Send a scoped update, pause for inspection, or cancel. Pause stops the process tree and ' +
      'preserves candidate and ownership. Wait for the paused outcome before revise_tasks or ' +
      'resume_task. Cancellation releases ownership after the worker stops.',
    parameters: Type.Object({
      id: idSchema,
      action: Type.Union([Type.Literal('message'), Type.Literal('pause'), Type.Literal('cancel')]),
      message: Type.Optional(Type.String({ maxLength: 12000 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return textResult(
        await new Delegations(await storeFor(ctx.cwd)).control(args.id, args.action, args.message),
      )
    },
  })
  pi.registerTool({
    name: 'revise_tasks',
    label: 'Revise paused assignments',
    description:
      'Revise prompts and partition existing scope across stopped tasks as one batch. ' +
      'Supply updated context. Omit writePaths to keep ownership. Transfer edits, reject ' +
      'conflicts, and invalidate old review approvals. Every task remains paused. Branch ' +
      'prompts may change, but moving branch ownership needs replacement tasks.',
    parameters: revisionSchema,
    async execute(_id, args, _signal, _update, ctx) {
      const jobs = new Delegations(await storeFor(ctx.cwd))
      return textResult((await reviseTasks(jobs, args)).map(delegationView))
    },
  })
  pi.registerTool({
    name: 'resume_task',
    label: 'Resume retained task',
    description:
      'Resume a paused or failed task after inspecting its blocker and retained work. ' +
      'Reuses the candidate and starts fresh orchestration with current instructions. ' +
      'Conflicting ownership is rejected. Explicitly cancelled work needs a new user request.',
    parameters: Type.Object({ id: idSchema }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!ctx.model) {
        throw new Error('Select a model first')
      }

      const jobs = new Delegations(await storeFor(ctx.cwd))
      return textResult(
        delegationView(
          await jobs.resume(
            args.id,
            {
              session: ctx.sessionManager.getSessionId(),
              originEntry: ctx.sessionManager
                .getBranch()
                .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
              model: `${ctx.model.provider}/${ctx.model.id}`,
            },
            launch,
          ),
        ),
      )
    },
  })
  return { start }
}
