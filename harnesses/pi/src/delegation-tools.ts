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
import { launchDelegation } from './delegation-process.ts'
import {
  Delegations,
  activeTask,
  delegateSchema,
  delegationView,
  scopesOverlap,
  type DelegateInput,
  type Delegation,
  type DelegationRequest,
} from './delegation-state.ts'

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

function resultMessage(jobs: Delegation[]): CustomMessageEntryDraft {
  return {
    type: 'custom_message',
    customType: 'pi-task-result',
    display: true,
    content:
      'Background task completion. Briefly acknowledge the outcome and any blocker, ' +
      'then continue the current discussion. Do not launch follow-up work unless authorized.\n' +
      JSON.stringify(jobs.map(delegationView)),
    details: { taskIds: jobs.map(notificationId) },
  }
}

export function registerDelegation(pi: ExtensionAPI, launch: Launcher = launchDelegation) {
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
          ? `Tasks · ${jobs.filter((job) => activeTask(job.state)).length} active`
          : undefined,
      )
      const branch = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id))
      const persisted = new Set(
        ctx.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === 'custom_message' && entry.customType === 'pi-task-result'
              ? messageIds(entry.details)
              : [],
          ),
      )
      const ready = jobs.filter(
        (job) =>
          !activeTask(job.state) &&
          job.request.session === session &&
          (!job.request.originEntry || branch.has(job.request.originEntry)) &&
          !persisted.has(notificationId(job)) &&
          !delivered.has(`${session}:${notificationId(job)}`),
      )

      for (const job of ready) {
        delivered.add(`${session}:${notificationId(job)}`)
      }

      return ready.length ? [resultMessage(ready)] : []
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

    for (const message of messages) {

      // One batch wakes an idle orchestrator once; ordinary polling never invokes a model.
      pi.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' })
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
          ...(event.context.pendingMessages.length ? {} : { continue: true }),
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
      activeTask(job.state),
    )

    if (active.length) {
      return {
        message: {
          customType: 'pi-active-tasks',
          display: false,
          content:
            'Active background tasks; continue discussion and do not edit their owned paths.\n' +
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
        activeTask(job.state) &&
        scopesOverlap(names, job.request.writePaths)
      ) {
        return {
          block: true,
          reason:
            `Task ${job.request.id} owns these files. ` +
            'Send task_control a message or cancel it.',
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
      'Use for explicit delegation, multi-file document work, research or maintenance. Return ' +
      'immediately and continue discussion. Supply decisions, context and bounded writePaths.',
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
    label: 'Update or cancel background task',
    description:
      'Send a scoped update to an active coordinator or cancel its work. Cancellation ' +
      'releases ownership after the worker stops. Scope expansion needs a new task.',
    parameters: Type.Object({
      id: idSchema,
      action: Type.Union([Type.Literal('message'), Type.Literal('cancel')]),
      message: Type.Optional(Type.String({ maxLength: 12000 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return textResult(
        await new Delegations(await storeFor(ctx.cwd)).control(args.id, args.action, args.message),
      )
    },
  })
  return { start }
}
