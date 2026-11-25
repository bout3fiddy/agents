import { WorkersCatalog } from './workers-data.ts'
import { taskStatusSchema } from './inspection-schema.ts'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Type } from 'typebox'
import type {
  AgentBeforeSettleEvent,
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent'
import { StateStore } from './state.ts'
import { structuredResult, textResult } from './file-tools.ts'
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
import { implementationRecovery, revisionSchema, reviseTasks } from './task-recovery.ts'

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
  const actionableAudit = jobs.some(
    ({ request, state }) =>
      request.recurring?.audit && (state.auditRequired?.length || state.hostActions?.length),
  )
  return {
    type: 'custom_message',
    customType: 'pi-task-result',
    display: false,
    content:
      'Background task outcome. Assess material changes to project dependencies or priorities. ' +
      (actionableAudit
        ? 'An audit identified work for the host. Check the required findings against the ' +
          'latest user priority. Advance the authorized next step or identify its concrete ' +
          'dependency and owner. A completed audit does not complete the objective. '
        : 'Handle routine completions privately. ') +
      'When an outcome changes what the user can use, decide or expect, combine related ' +
      'results into one short update. Answer pending questions first. ' +
      (jobs.some((job) => job.request.local)
        ? 'Compare verified local candidates and integrate the selected work when in scope. '
        : '') +
      'For failures, inspect the retained candidate and evidence. ' +
      'Recover within the original authorized scope: handle host-only operations on the host, ' +
      'preserve useful work and rerun relevant checks. Do not repeat a worker lacking the needed ' +
      'capability or expand permission. Paused work is preserved: inspect, revise and resume it ' +
      'when consistent with user instructions. Never restart user-cancelled work without a new ' +
      'request. Report genuine external blockers.\n' +
      JSON.stringify(jobs.map(delegationView)),
    details: { taskIds: jobs.map(notificationId), ...(actionableAudit && { actionableAudit }) },
  }
}

export function registerDelegation(
  pi: ExtensionAPI,
  launch: Launcher = launchDelegation,
  afterMerge?: () => void,
) {
  pi.registerMessageRenderer('pi-task-progress', () => ({ render: () => [], invalidate() {} }))
  const feed = new TaskFeed(pi, afterMerge)
  const boundary = (event: BoundaryState, ctx: ExtensionContext) => feed.boundary(event, ctx)
  pi.on('turn_end', boundary)
  pi.on('agent_before_settle', async (event, ctx) => {
    const delivery = await boundary(event, ctx)

    if (
      delivery ||
      event.outcome !== 'completed' ||
      event.continue ||
      event.context.pendingMessages.length
    ) {
      return delivery
    }

    return priorityFollowUp(event)
  })
  pi.on('agent_settled', async (_event, ctx) => feed.idle(ctx))
  pi.on('session_start', (_event, ctx) => feed.open(ctx))
  pi.on('before_agent_start', async (_event, ctx) => {
    feed.current = ctx
    return activeTasksMessage(ctx)
  })
  feed.observe()
  pi.on('session_shutdown', () => feed.close())
  pi.on('tool_call', ownershipBlock)
  const start = (ctx: ExtensionContext, input: DelegateInput) => startTask(ctx, input, launch)
  registerDelegateTask(pi, start)
  registerTaskStatus(pi)
  registerTaskControl(pi)
  registerReviseTasks(pi)
  registerResumeTask(pi, launch)
  return { start }
}

/** What one session has already seen, so each notification reaches it once. */
type SessionView = {
  session: string
  entries: ReturnType<ExtensionContext['sessionManager']['getEntries']>
  branch: Set<string>
  persisted: Set<string>
}

type Milestone = { id: string; task: string; summary: string }

const notificationTypes = [
  'pi-task-result',
  'pi-task-progress',
  'pi-task-attention',
  'pi-task-milestone',
]

/** Delivers background task outcomes, progress and milestones into the host session. */
class TaskFeed {
  current: ExtensionContext | undefined
  private closed = false
  private collecting = false
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly delivered = new Set<string>()

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly afterMerge?: () => void,
  ) {}

  open(ctx: ExtensionContext) {
    this.closed = false
    this.current = ctx
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
  }

  /** Poll once a second so outcomes arrive while the host is idle. */
  observe() {
    this.timer = setInterval(() => {
      if (this.current && !this.closed) {
        void this.idle(this.current).catch((error: unknown) => this.stopObserving(error))
      }
    }, 1000)
    this.timer.unref()
  }

  private stopObserving(error: unknown) {
    this.close()

    try {
      this.current?.ui.setStatus(
        'pi-tasks',
        `Task observer stopped; reload to resume: ${String(error).slice(0, 120)}`,
      )
    } catch {
      // SDK disposal can invalidate a context without emitting session_shutdown.
    }
  }

  async collect(ctx: ExtensionContext): Promise<CustomMessageEntryDraft[]> {
    if (this.closed || this.collecting) {
      return []
    }

    this.collecting = true

    try {
      const session = ctx.sessionManager.getSessionId()
      const jobs = await new Delegations(await storeFor(ctx.cwd)).list()

      if (this.closed || session !== ctx.sessionManager.getSessionId()) {
        return []
      }

      ctx.ui.setStatus('pi-tasks', taskStatusLine(jobs))
      const view = sessionView(ctx, session)
      const ready = this.readyResults(jobs, view)
      const messages: CustomMessageEntryDraft[] = ready.length ? [resultMessage(ready)] : []
      const milestones = this.progress(jobs, view, messages)
      const milestone = this.milestoneMessage(milestones, view, messages)
      return milestone ? [...messages, milestone] : messages
    } finally {
      this.collecting = false
    }
  }

  private seen(view: SessionView, id: string) {
    return view.persisted.has(id) || this.delivered.has(`${view.session}:${id}`)
  }

  private deliver(view: SessionView, id: string) {
    this.delivered.add(`${view.session}:${id}`)
  }

  /** Finished tasks of this session and branch whose outcome has not been delivered. */
  private readyResults(jobs: Delegation[], view: SessionView): Delegation[] {
    const ready = jobs.filter(
      (job) =>
        !activeTask(job.state) &&
        !quietAudit(job) &&
        ownedByView(job, view) &&
        !this.seen(view, notificationId(job)),
    )

    for (const job of ready) {
      this.deliver(view, notificationId(job))
    }

    if (
      ready.some(
        ({ request, state }) =>
          request.kind === 'branch' &&
          request.branch?.remote === 'origin' &&
          state.status === 'complete' &&
          state.mergeBase,
      )
    ) {
      this.afterMerge?.()
    }

    return ready
  }

  /** Append progress or attention messages for active tasks; return undelivered milestones. */
  private progress(
    jobs: Delegation[],
    view: SessionView,
    messages: CustomMessageEntryDraft[],
  ): Milestone[] {
    const milestones: Milestone[] = []
    const active = jobs.filter(
      (job) => activeTask(job.state) && !job.request.recurring?.audit && ownedByView(job, view),
    )

    for (const job of active) {
      const progress = job.state.progress
      const route = progress?.child ?? progress

      if (route?.fallbackReason) {
        const id = `${job.request.id}:quota:${route.requestedModel}:${route.confirmedAt}`

        if (!this.seen(view, id)) {
          milestones.push({
            id,
            task: job.request.task.slice(0, 160),
            summary: `${route.requestedModel} → ${route.actualModel} (${route.fallbackReason})`,
          })
        }
      }

      const milestone = taskMilestone(job)
      const milestoneId = milestone && `${job.request.id}:milestone:${milestone.key}`

      if (milestone && milestoneId && !this.seen(view, milestoneId)) {
        milestones.push({
          id: milestoneId,
          task: job.request.task.slice(0, 160),
          summary: milestone.summary,
        })
      }

      const activity = progress?.child?.updatedAt ?? progress?.updatedAt ?? job.state.updatedAt
      const attention = job.state.health === 'quiet'
      const id = `${job.request.id}:${attention ? 'attention' : 'progress'}:${activity}`
      const previous = view.entries.findLast(
        (entry) =>
          entry.type === 'custom_message' &&
          entry.customType === 'pi-task-progress' &&
          (entry.details as { taskId?: string })?.taskId === job.request.id,
      )
      const since = previous?.timestamp ?? job.request.createdAt

      if ((!attention && Date.now() - Date.parse(since) < 60000) || this.seen(view, id)) {
        continue
      }

      this.deliver(view, id)
      messages.push(progressMessage(job, id, attention))
    }

    return milestones
  }

  /** Batch milestones at most once a minute unless another message already wakes the host. */
  private milestoneMessage(
    milestones: Milestone[],
    view: SessionView,
    messages: CustomMessageEntryDraft[],
  ): CustomMessageEntryDraft | undefined {
    if (!milestones.length) {
      return undefined
    }

    const previous = view.entries.findLast(
      (entry) =>
        entry.type === 'custom_message' &&
        entry.customType === 'pi-task-milestone' &&
        view.branch.has(entry.id),
    )
    const waking = messages.some((message) => message.customType !== 'pi-task-progress')

    if (previous && !waking && Date.now() - Date.parse(previous.timestamp) < 60000) {
      return undefined
    }

    const taskIds = milestones.map(({ id }) => id)

    for (const id of taskIds) {
      this.deliver(view, id)
    }

    return {
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
    }
  }

  /** Deliver collected messages while idle; only the last non-progress message wakes a turn. */
  async idle(ctx: ExtensionContext) {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return
    }

    const messages = await this.collect(ctx)

    if (this.closed || !ctx.isIdle() || ctx.hasPendingMessages()) {
      for (const message of messages) {
        for (const id of messageIds(message.details)) {
          this.delivered.delete(`${ctx.sessionManager.getSessionId()}:${id}`)
        }
      }

      return
    }

    const wake = messages.findLast((message) => message.customType !== 'pi-task-progress')

    for (const message of messages) {
      if (message !== wake) {
        this.pi.sendMessage(message, { triggerTurn: false, deliverAs: 'followUp' })
      }
    }

    if (wake) {
      this.pi.sendMessage(wake, { triggerTurn: true, deliverAs: 'followUp' })
    }
  }

  /** Append collected messages at a completed boundary; continue unless all are progress. */
  async boundary(event: BoundaryState, ctx: ExtensionContext) {
    if (event.outcome !== 'completed') {
      return
    }

    const messages = await this.collect(ctx)
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
}

function taskStatusLine(jobs: Delegation[]): string | undefined {
  const active = jobs.filter((job) => activeTask(job.state))

  if (!active.length) {
    return undefined
  }

  return (
    'Tasks · ' +
    active
      .map((job) => {
        const progress = job.state.progress
        return (
          `${job.request.id.slice(0, 6)} ${progress?.role ?? job.state.status}/` +
          `${progress?.child?.tool ?? progress?.stage ?? 'starting'}`
        )
      })
      .join(' · ')
  )
}

function sessionView(ctx: ExtensionContext, session: string): SessionView {
  const entries = ctx.sessionManager.getEntries()
  return {
    session,
    entries,
    branch: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    persisted: new Set(
      entries.flatMap((entry) =>
        entry.type === 'custom_message' && notificationTypes.includes(entry.customType)
          ? messageIds(entry.details)
          : [],
      ),
    ),
  }
}

/** A recurring audit that was cancelled or found nothing needs no host attention. */
function quietAudit(job: Delegation) {
  return Boolean(
    job.request.recurring?.audit &&
    (job.state.status === 'cancelled' ||
      (job.state.status === 'complete' && job.state.auditAttention === false)),
  )
}

/** Tasks belong to the session and conversation branch that started them. */
function ownedByView(job: Delegation, view: SessionView) {
  return (
    job.request.session === view.session &&
    (!job.request.originEntry || view.branch.has(job.request.originEntry))
  )
}

function progressMessage(job: Delegation, id: string, attention: boolean): CustomMessageEntryDraft {
  return {
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
        progress: job.state.progress,
        activityAgeMs: job.state.activityAgeMs,
      }),
    details: { taskIds: [id], taskId: job.request.id },
  }
}

/** An empty reply to an actionable audit gets one follow-up asking for a decision or action. */
function priorityFollowUp(event: AgentBeforeSettleEvent) {
  const messages = event.context.contextMessages
  const last = messages.at(-1)

  if (
    last?.role !== 'assistant' ||
    last.stopReason !== 'stop' ||
    last.content.some((part) => part.type === 'text' && part.text.trim())
  ) {
    return undefined
  }

  for (let i = messages.length - 2; i >= 0; i--) {
    const previous = messages[i]!

    if (previous.role !== 'custom') {
      return undefined
    }

    if (['pi-active-tasks', 'pi-task-progress'].includes(previous.customType)) {
      continue
    }

    if (
      previous.customType === 'pi-task-result' &&
      (previous.details as { actionableAudit?: boolean } | undefined)?.actionableAudit
    ) {
      return {
        entries: [
          ...event.entries,
          {
            type: 'custom_message' as const,
            customType: 'pi-priority-follow-up',
            display: false,
            content:
              'The last audit reported a required finding and received an empty response. ' +
              'Reconcile it with the user’s priority. Take an available authorized action, or ' +
              'surface the specific decision that prevents progress. If already handled, stop.',
          },
        ],
        continue: true,
      }
    }

    return undefined
  }

  return undefined
}

async function activeTasksMessage(ctx: ExtensionContext) {
  const jobs = await new Delegations(await storeFor(ctx.cwd)).list()
  const active = jobs.filter((job) => ownsTaskPaths(job.state))

  if (!active.length) {
    return undefined
  }

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

/** Host edits to files a task owns are blocked until the task releases them. */
async function ownershipBlock(event: ToolCallEvent, ctx: ExtensionContext) {
  const input = event.input as { path?: string; paths?: string[]; format?: boolean }
  const paths =
    ['write', 'edit'].includes(event.toolName) && input.path
      ? [input.path]
      : event.toolName === 'document_check' && input.format
        ? (input.paths ?? [])
        : []

  if (!paths.length) {
    return undefined
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
          (job.request.kind === 'implementation'
            ? implementationRecovery
            : 'Use task_control to steer or pause, then revise_tasks to reassign ownership.'),
      }
    }
  }

  return undefined
}

/** The session, conversation entry and model a started or resumed task reports back to. */
function taskOrigin(ctx: ExtensionContext) {
  if (!ctx.model) {
    throw new Error('Select a model first')
  }

  return {
    originRoot: ctx.sessionManager.getHeader?.()?.cwd ?? ctx.cwd,
    session: ctx.sessionManager.getSessionId(),
    originEntry: ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
    model: `${ctx.model.provider}/${ctx.model.id}`,
  }
}

async function startTask(ctx: ExtensionContext, input: DelegateInput, launch: Launcher) {
  const origin = taskOrigin(ctx)
  const job = await new Delegations(await storeFor(ctx.cwd)).start(input, origin, launch)
  return textResult({
    ...delegationView(job),
    next: 'Continue the conversation. Completion arrives automatically; do not poll or wait.',
  })
}

function registerDelegateTask(
  pi: ExtensionAPI,
  start: (ctx: ExtensionContext, input: DelegateInput) => ReturnType<typeof startTask>,
) {
  pi.registerTool({
    name: 'delegate_task',
    label: 'Delegate background task',
    description:
      'Start a background coordinator that can delegate scoped workers. ' +
      'Use for substantial implementation, explicit delegation or work that would disrupt the ' +
      'current discussion. Routine setup and related small work may stay on the host. Workers ' +
      'cannot install dependencies, use the network or publish Git; declare host requirements. ' +
      'Return immediately and continue discussion. Supply context and scoped writePaths. ' +
      'For explicit Claude comparisons set implementerModel with research and empty writePaths. ' +
      'For document edits use documents and authorized paths with the same selector. ' +
      'Select performanceReview only when the user asks for performance work. Put implementation ' +
      'review options inside its design. Omit design to resume the recorded scope.',
    parameters: delegateSchema,
    async execute(_id, args, _signal, _update, ctx) {
      return start(ctx, args)
    },
  })
}

function registerTaskStatus(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'task_status',
    label: 'Inspect background tasks',
    description:
      'Inspect saved task status/evidence when needed. Completion arrives automatically.',
    parameters: Type.Object({ id: Type.Optional(idSchema) }),
    outputSchema: Type.Union([taskStatusSchema, Type.Array(taskStatusSchema)]),
    async execute(_id, args, _signal, _update, ctx) {
      const jobs = new Delegations(await storeFor(ctx.cwd))
      return structuredResult(
        args.id ? delegationView(await jobs.get(args.id)) : (await jobs.list()).map(delegationView),
      )
    },
  })
}

function registerTaskControl(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'task_control',
    label: 'Steer, pause or cancel task',
    description:
      'Use evidence to send a host observation to the active implementer of a fixed design. ' +
      'Use message for task updates. Pause stops the process tree and ' +
      'preserves candidate and ownership. Wait for the paused outcome before revise_tasks or ' +
      'resume_task. Cancellation releases ownership after the worker stops.',
    parameters: Type.Object({
      id: idSchema,
      action: Type.Union([
        Type.Literal('message'),
        Type.Literal('evidence'),
        Type.Literal('pause'),
        Type.Literal('cancel'),
      ]),
      message: Type.Optional(Type.String({ maxLength: 12000 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (args.action === 'evidence') {
        return textResult(
          await new WorkersCatalog(
            await realpath(ctx.cwd),
            undefined,
            undefined,
            ctx.sessionManager.getSessionId(),
          ).sendEvidence(args.id, args.message ?? ''),
        )
      }

      return textResult(
        await new Delegations(await storeFor(ctx.cwd)).control(args.id, args.action, args.message),
      )
    },
  })
}

function registerReviseTasks(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'revise_tasks',
    label: 'Revise paused assignments',
    description:
      'Revise stopped documents, maintenance, research or branch tasks. ' +
      'For a changed local implementation assignment use workflow with the revised design. ' +
      'Supply updated context. Omit writePaths to keep ownership. Transfer edits, reject ' +
      'conflicts, and invalidate old review approvals. Every task remains paused. Branch ' +
      'prompts may change, but moving branch ownership needs replacement tasks.',
    parameters: revisionSchema,
    async execute(_id, args, _signal, _update, ctx) {
      const jobs = new Delegations(await storeFor(ctx.cwd))
      return textResult((await reviseTasks(jobs, args)).map(delegationView))
    },
  })
}

function registerResumeTask(pi: ExtensionAPI, launch: Launcher) {
  pi.registerTool({
    name: 'resume_task',
    label: 'Resume retained task',
    description:
      'Resume a paused or failed task after inspecting its blocker and retained work. ' +
      'Reuses the candidate and starts fresh orchestration with current instructions. ' +
      'Conflicting ownership is rejected. Explicitly cancelled work needs a new user request.',
    parameters: Type.Object({ id: idSchema }),
    async execute(_id, args, _signal, _update, ctx) {
      const origin = taskOrigin(ctx)
      const jobs = new Delegations(await storeFor(ctx.cwd))
      return textResult(delegationView(await jobs.resume(args.id, origin, launch)))
    },
  })
}
