import { WorkersCatalog } from './workers-data.ts'
import { taskStatusLine } from './task-footer.ts'
import { taskStatusSchema } from './inspection-schema.ts'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import { freshBootstrapRoot, hostFileAllowed, workerHandoff } from './host-file-routing.ts'
import { projectRoot } from './tiger-style.ts'
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
import { DeliveryLedger, deliveryLimits, liveSession, type DeliveryLimits } from './delivery.ts'
import type { BoundTask, TaskOwner } from './host-work.ts'
import { Check } from 'typebox/value'

type Launcher = (request: DelegationRequest) => Promise<void>
const idSchema = Type.String({ minLength: 36, maxLength: 36 })
const projectSchema = Type.String({ minLength: 1, maxLength: 1024 })
const storeFor = async (cwd: string) => new StateStore(await realpath(cwd))

// A cross-checkout dispatch made through a task tool, recorded in the dispatching session.
const routeType = 'pi-task-route'
const routeSchema = Type.Object({
  id: Type.String(),
  project: Type.String(),
  session: Type.String(),
})
const maxRoutes = 128

/** The assignment records the task tools consult; only the bindings, never the records. */
export type TaskBindings = {
  boundTasks(session: string): BoundTask[]

  /**
   * Throws unless the user confirmed this stop, when an open assignment tracks the task:
   * cancelling one of this session's, or pausing or cancelling one of another session's.
   */
  authorizeTaskStop(
    ctx: ExtensionContext,
    action: 'pause' | 'cancel',
    task: TaskOwner,
  ): Promise<void>
}
export type FeedOptions = {
  assignments?: TaskBindings

  /** Idle observation period. */
  tickMs?: number
  delivery?: DeliveryLimits
}

/**
 * The checkout a task tool addresses: the session's own, or another checkout or worktree the
 * host names. Routing through the tool keeps that project's registry, reservations, checks and
 * worker execution policy in force; a host shell started there would bypass all of them.
 */
async function taskStore(ctx: ExtensionContext, project?: string): Promise<StateStore> {
  if (project === undefined) {
    return storeFor(ctx.cwd)
  }

  if (!isAbsolute(project) || project.includes('\0')) {
    throw new Error('project is the absolute path of a checkout or worktree root')
  }

  let root: string

  try {
    root = await realpath(project)
  } catch {
    throw new Error(`No checkout at ${project}`)
  }

  if (root.split(sep).includes('.pi')) {
    throw new Error(
      'Task candidates and private harness directories belong to their task. ' +
        'Steer that task instead of dispatching into its workspace.',
    )
  }

  const marked = await Promise.all(
    ['.git', '.pi'].map((name) =>
      lstat(join(root, name)).then(
        () => true,
        () => false,
      ),
    ),
  )

  if (!marked.includes(true)) {
    throw new Error(`${root} is not a checkout root: it has neither .git nor .pi`)
  }

  return new StateStore(root)
}

/** A task in another checkout is steered only by the session that started it. */
function requireOwnTask(job: Delegation, session: string, project?: string) {
  if (
    project !== undefined &&
    job.request.session !== session &&
    job.request.originSession !== session
  ) {
    throw new Error(
      `Task ${job.request.id} in ${project} belongs to another session; steer it from there`,
    )
  }
}

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

function resultMessage(
  jobs: Delegation[],
  bound: ReadonlyMap<string, BoundTask>,
): CustomMessageEntryDraft {
  const actionableAudit = jobs.some(
    ({ request, state }) =>
      request.recurring?.audit && (state.auditRequired?.length || state.hostActions?.length),
  )
  const assignments = jobs.flatMap(({ request }) => {
    const binding = bound.get(request.id)
    return binding
      ? [
          {
            task: request.id,
            assignment: binding.assignment,
            outcome: binding.outcome,
            target: binding.target,
          },
        ]
      : []
  })
  const delivered = jobs.filter(deliveredDocuments).map(({ request }) => request.id)
  const deliveredBound = assignments.some(({ task }) => delivered.includes(task))
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
      (assignments.length
        ? 'These results belong to recorded assignments: ' +
          JSON.stringify(assignments) +
          '. Continue each named assignment and no other; leave a paused one paused. A ' +
          'finished worker, candidate or preview is not delivery to its target: you own ' +
          'acceptance and the next step. '
        : '') +
      (delivered.length
        ? 'A complete task whose view carries delivery is a documents task the harness ' +
          'already checked and applied: write scope, document type, Markdown format and line ' +
          'width passed on exactly that content, and delivery.checkout received ' +
          'delivery.revision with the listed file hashes and word counts. Treat that receipt ' +
          'as verified. Do not repeat document_check, hashing, word counts or a status ' +
          'lookup. Read a delivered file once only if its content still has to be judged ' +
          'against the outcome. '
        : '') +
      (deliveredBound
        ? 'When a named assignment has those documents in that checkout as its target, the ' +
          'receipt is its delivery evidence: close it with host_work done, evidence target ' +
          'the assignment target and revision delivery.revision, then acknowledge briefly. ' +
          'For any other target the receipt is progress and the assignment stays open. '
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

/** A documents task the supervisor checked, applied and issued a delivery receipt for. */
function deliveredDocuments({ request, state }: Delegation): boolean {
  return request.kind === 'documents' && state.status === 'complete' && Boolean(state.delivery)
}

/**
 * Tell the model which outcome messages repeat one it already received. Delivery is retried
 * until its receipt is persisted, so a slow receipt can produce a second copy; the copy keeps
 * its place in the transcript and loses its instructions.
 */
function withoutRepeatedOutcomes<T extends { role: string }>(messages: T[]): T[] | undefined {
  const received = new Set<string>()
  let repeated = false
  const kept = messages.map((message) => {
    const custom = message as T & { customType?: string; details?: unknown }

    if (custom.role !== 'custom' || custom.customType !== 'pi-task-result') {
      return message
    }

    const ids = messageIds(custom.details)

    if (ids.length && ids.every((id) => received.has(id))) {
      repeated = true
      return {
        ...message,
        content:
          'Repeated delivery of a background task outcome already received above (' +
          ids.join(', ') +
          '). It carries nothing new: take no action for this notice.',
      }
    }

    for (const id of ids) {
      received.add(id)
    }

    return message
  })
  return repeated ? kept : undefined
}

export function registerDelegation(
  pi: ExtensionAPI,
  launch: Launcher = launchDelegation,
  afterMerge?: () => void,
  options: FeedOptions = {},
) {
  pi.registerMessageRenderer('pi-task-progress', () => ({ render: () => [], invalidate() {} }))
  const feed = new TaskFeed(pi, afterMerge, options)
  pi.on('context', ({ messages }) => {
    const kept = withoutRepeatedOutcomes(messages)
    return kept ? { messages: kept } : undefined
  })
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
  let bootstrapRoot: string | undefined
  pi.on('before_agent_start', async (_event, ctx) => {
    bootstrapRoot = await freshBootstrapRoot(ctx.cwd)
    feed.current = ctx
    return activeTasksMessage(ctx)
  })
  feed.observe()
  pi.on('session_shutdown', () => feed.close())
  pi.on('tool_call', (event, ctx) => hostWriteBlock(event, ctx, bootstrapRoot))
  const start = (ctx: ExtensionContext, input: DelegateInput, project?: string) =>
    startTask(ctx, input, launch, project, feed)
  registerDelegateTask(pi, start)
  registerTaskStatus(pi)
  registerTaskControl(pi, options.assignments)
  registerReviseTasks(pi)
  registerResumeTask(pi, launch, feed)
  return { start }
}

/** What one session has already seen, so each notification reaches it once. */
type SessionView = {
  session: string
  entries: ReturnType<ExtensionContext['sessionManager']['getEntries']>
  branch: Set<string>
  persisted: Set<string>

  /** Tasks bound to an open assignment: delivered whatever branch the session is on. */
  bound: ReadonlyMap<string, BoundTask>
  now: number

  /** Collected at a turn boundary, which appends reliably, rather than as an idle wake. */
  boundary: boolean
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

  /** Offered notifications awaiting their persisted receipt. An offer is not a delivery. */
  private readonly offers: DeliveryLedger

  /** Tasks in other checkouts whose current outcome this session has already received. */
  private readonly settledElsewhere = new Set<string>()

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly afterMerge?: () => void,
    private readonly options: FeedOptions = {},
  ) {
    this.offers = new DeliveryLedger(options.delivery ?? deliveryLimits)
  }

  /** A task in another checkout was started again: observe it once more. */
  reopen(id: string) {
    this.settledElsewhere.delete(id)
  }

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
    }, this.options.tickMs ?? 1000)
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

  /**
   * The session this feed may still deliver into through ctx, or undefined once it has shut down
   * or the SDK has invalidated ctx. The context and this feed's pi share one extension runtime,
   * so invalidation ends the feed for good; a reload or replacement session loads its own feed.
   */
  private owned(ctx: ExtensionContext): string | undefined {
    if (this.closed) {
      return undefined
    }

    const session = liveSession(ctx)

    if (session === undefined) {
      this.close()
    }

    return session
  }

  /** Forget unsent messages so the session's next owner still delivers them. */
  private retract(session: string, messages: CustomMessageEntryDraft[]) {
    for (const message of messages) {
      for (const id of messageIds(message.details)) {
        this.offers.retract(`${session}:${id}`)
      }
    }
  }

  /** Record that this session dispatched a task into another checkout through a task tool. */
  route(job: Delegation, session: string) {
    this.pi.appendEntry(routeType, { id: job.request.id, project: job.request.root, session })
  }

  /**
   * Tasks this session routed into another checkout or bound to one of its assignments. Each is
   * read from its owning registry; nothing is copied or moved. A task that is merely listed in
   * the origin index stays display-only, as before.
   */
  private async elsewhere(
    local: StateStore,
    session: string,
    routes: { id: string; project: string }[],
  ): Promise<Delegation[]> {
    const wanted = new Map(routes.map((route) => [route.id, route.project]))
    const jobs: Delegation[] = []

    for (const [id, root] of wanted) {
      if (root === local.projectRoot || this.settledElsewhere.has(id)) {
        continue
      }

      try {
        const job = await new Delegations(new StateStore(root, undefined, false)).get(id)

        if (job.request.session === session || job.request.originSession === session) {
          jobs.push(job)
        }
      } catch {
        // A removed or unreadable checkout cannot report. Its assignment records that itself.
      }
    }

    return jobs
  }

  async collect(ctx: ExtensionContext, boundary = false): Promise<CustomMessageEntryDraft[]> {
    const session = this.collecting ? undefined : this.owned(ctx)

    if (session === undefined) {
      return []
    }

    this.collecting = true

    try {
      const store = await storeFor(ctx.cwd)
      const local = await new Delegations(store).list()
      const footer = await taskStatusLine(store, local, session)

      // The session can shut down, be disposed or change while reads are pending. Check after
      // each group of reads and before touching the context or marking anything delivered.
      if (this.owned(ctx) !== session) {
        return []
      }

      const bound = this.options.assignments?.boundTasks(session) ?? []
      const routes = [...routedTasks(ctx, session), ...bound]
      const jobs = [...local, ...(await this.elsewhere(store, session, routes))]

      // Everything after this check runs without yielding.
      if (this.owned(ctx) !== session) {
        return []
      }

      ctx.ui.setStatus('pi-tasks', footer)
      const view = sessionView(ctx, session, bound, boundary)
      this.reportUndelivered(ctx, view)
      const ready = this.readyResults(jobs, view)

      for (const job of jobs) {
        if (job.request.root !== store.projectRoot && view.persisted.has(notificationId(job))) {
          this.settledElsewhere.add(job.request.id)
        }
      }

      const messages: CustomMessageEntryDraft[] = ready.length
        ? [resultMessage(ready, view.bound)]
        : []
      const milestones = this.progress(jobs, view, messages)
      const milestone = this.milestoneMessage(milestones, view, messages)
      return milestone ? [...messages, milestone] : messages
    } finally {
      this.collecting = false
    }
  }

  /** Say once that an outcome could not wake the session, instead of offering it forever. */
  private reportUndelivered(ctx: ExtensionContext, view: SessionView) {
    const prefix = view.session + ':'
    const tasks = this.offers
      .exhausted(view.now)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length, prefix.length + 8))

    if (tasks.length) {
      ctx.ui.notify(
        `Background task outcome (${tasks.join(', ')}) could not wake this session after ` +
          `${this.offers.limits.attempts} attempts. It stays recorded: task_status shows it ` +
          'and the next turn receives it.',
        'warning',
      )
    }
  }

  /** Whether id needs no offer now: its receipt is persisted, or an offer is still pending. */
  private seen(view: SessionView, id: string) {
    const key = `${view.session}:${id}`

    if (view.persisted.has(id)) {
      this.offers.acknowledge(key)
      return true
    }

    return view.boundary
      ? !this.offers.dueAtBoundary(key, view.now)
      : !this.offers.dueWhileIdle(key, view.now)
  }

  private deliver(view: SessionView, id: string) {
    this.offers.offer(`${view.session}:${id}`, view.now, view.boundary)
  }

  /**
   * Finished tasks whose outcome this session has not received: those of its current branch,
   * and those bound to one of its assignments on any branch.
   */
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
    const session = this.owned(ctx)

    if (session === undefined || !ctx.isIdle() || ctx.hasPendingMessages()) {
      return
    }

    const messages = await this.collect(ctx, false)

    if (this.owned(ctx) !== session || !ctx.isIdle() || ctx.hasPendingMessages()) {
      this.retract(session, messages)
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

    const messages = await this.collect(ctx, true)
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

/** Cross-checkout dispatches this session recorded, on any branch of its tree. */
function routedTasks(ctx: ExtensionContext, session: string) {
  return ctx.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'custom' &&
      entry.customType === routeType &&
      Check(routeSchema, entry.data) &&
      entry.data.session === session
        ? [entry.data]
        : [],
    )
    .slice(-maxRoutes)
}

function sessionView(
  ctx: ExtensionContext,
  session: string,
  bound: BoundTask[],
  boundary: boolean,
): SessionView {
  const entries = ctx.sessionManager.getEntries()
  return {
    session,
    bound: new Map(bound.map((task) => [task.id, task])),
    now: Date.now(),
    boundary,
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

/**
 * Tasks belong to the session and conversation branch that started them. A task bound to one of
 * the session's assignments belongs to that record instead, wherever the session tree now points.
 */
function ownedByView(job: Delegation, view: SessionView) {
  return (
    job.request.session === view.session &&
    (!job.request.originEntry ||
      view.branch.has(job.request.originEntry) ||
      view.bound.has(job.request.id))
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

/** A released reservation does not transfer product work to the host. */
async function hostWriteBlock(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  bootstrapRoot: string | undefined,
) {
  const input = event.input as { path?: string; paths?: string[]; format?: boolean }
  const paths =
    event.toolName === 'write' || event.toolName === 'edit'
      ? [input.path ?? '']
      : event.toolName === 'document_check' && input.format
        ? (input.paths ?? [])
        : []

  if (!paths.length) {
    return undefined
  }

  // SDK file tools expand shorthand. Require ordinary paths so both sides address the same file.
  if (
    paths.some(
      (path) => !path || /^[@~]|^file:|[^\S ]/u.test(path) || path.split('/').includes('..'),
    )
  ) {
    return { block: true, reason: 'Use a plain path without shorthand. ' + workerHandoff }
  }

  const store = await storeFor(ctx.cwd)
  const destinations = await Promise.all(paths.map((path) => destination(ctx.cwd, path)))
  const names = destinations.map((path) => relative(store.projectRoot, path))

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

  const root = await projectRoot(store.projectRoot)

  for (const path of destinations) {
    if (!(await hostFileAllowed(root, store.projectRoot, path, event, bootstrapRoot))) {
      return { block: true, reason: workerHandoff }
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

async function startTask(
  ctx: ExtensionContext,
  input: DelegateInput,
  launch: Launcher,
  project: string | undefined,
  feed: TaskFeed,
) {
  const origin = taskOrigin(ctx)
  const store = await taskStore(ctx, project)
  const job = await new Delegations(store).start(input, origin, launch)

  if (project !== undefined) {
    feed.route(job, origin.session)
  }

  return textResult({
    ...delegationView(job),
    ...(project !== undefined && { project: store.projectRoot }),
    next: 'Continue the conversation. Completion arrives automatically; do not poll or wait.',
  })
}

const otherCheckout =
  'Set project to the absolute root of another checkout or worktree to address a task there; ' +
  'that project keeps its own reservations, checks and worker execution policy. '

function registerDelegateTask(
  pi: ExtensionAPI,
  start: (
    ctx: ExtensionContext,
    input: DelegateInput,
    project?: string,
  ) => ReturnType<typeof startTask>,
) {
  pi.registerTool({
    name: 'delegate_task',
    label: 'Delegate background task',
    description:
      'Start a background coordinator that can delegate scoped workers. ' +
      'Use for product changes, including routine maintenance and repairs. ' +
      'Do not split fresh repository bootstrap files into a delegated task. Workers ' +
      'cannot install dependencies or publish Git; declare host requirements. Worker commands ' +
      'are sandboxed without network unless the user enrolled the project as trusted-local. ' +
      'Set isolation to required when the task or its inputs are external or untrusted: its ' +
      'coordinator, children and checks then stay sandboxed in every project, also after ' +
      'resume or revision. ' +
      'Return immediately and continue discussion. Supply context and scoped writePaths. ' +
      'For explicit Claude comparisons set implementerModel with research and empty writePaths. ' +
      'For product documentation and design reorganizations, use documents with authorized paths ' +
      'and the same model selector. ' +
      'Never delegate a direct save of a small settled workshop decision: create or edit the ' +
      'requested design file on the host and verify its contents before replying. ' +
      'Select performanceReview only when the user asks for performance work. Put implementation ' +
      'review options inside its design. Omit design to resume the recorded scope. ' +
      otherCheckout +
      'Never start a worker there through the host shell.',
    parameters: Type.Object(
      { ...delegateSchema.properties, project: Type.Optional(projectSchema) },
      { additionalProperties: false },
    ),
    async execute(_id, args, _signal, _update, ctx) {
      const { project, ...input } = args
      return start(ctx, input, project)
    },
  })
}

function registerTaskStatus(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'task_status',
    label: 'Inspect background tasks',
    description:
      'Inspect saved task status/evidence when needed. Completion arrives automatically. ' +
      otherCheckout,
    parameters: Type.Object({
      id: Type.Optional(idSchema),
      project: Type.Optional(projectSchema),
    }),
    outputSchema: Type.Union([taskStatusSchema, Type.Array(taskStatusSchema)]),
    async execute(_id, args, _signal, _update, ctx) {
      const jobs = new Delegations(await taskStore(ctx, args.project))
      return structuredResult(
        args.id ? delegationView(await jobs.get(args.id)) : (await jobs.list()).map(delegationView),
      )
    },
  })
}

function registerTaskControl(pi: ExtensionAPI, assignments?: TaskBindings) {
  pi.registerTool({
    name: 'task_control',
    label: 'Steer, pause or cancel task',
    description:
      'Use evidence to send a host observation to the active implementer of a fixed design. ' +
      'Use message for task updates. Pause stops the process tree and ' +
      'preserves candidate and ownership. Wait for the paused outcome before revise_tasks or ' +
      'resume_task. Cancellation releases ownership after the worker stops. Each action ' +
      'reaches the one named task. Cancelling a task that an open assignment waits on is ' +
      "accepted only on the user's own confirmation: a line of their latest message that " +
      'reads "cancel aN" for its assignment or "cancel" with the first eight characters of ' +
      'the task ID. Your message is not that authority; a new request or a change of ' +
      'priority never cancels recorded work. Pause it instead when you must reassign scope: ' +
      'its assignment stays open and returns to you. A task that advances an assignment ' +
      'another session recorded is not yours to stop: pausing or cancelling it needs the ' +
      'user\'s line "pause" or "cancel" with the first eight characters of the task ID. ' +
      otherCheckout,
    parameters: Type.Object({
      id: idSchema,
      project: Type.Optional(projectSchema),
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

      const jobs = new Delegations(await taskStore(ctx, args.project))
      const job = await jobs.get(args.id)
      requireOwnTask(job, ctx.sessionManager.getSessionId(), args.project)

      if (args.action === 'pause' || args.action === 'cancel') {
        await assignments?.authorizeTaskStop(ctx, args.action, job.request)
      }

      return textResult(await jobs.control(args.id, args.action, args.message))
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

function registerResumeTask(pi: ExtensionAPI, launch: Launcher, feed: TaskFeed) {
  pi.registerTool({
    name: 'resume_task',
    label: 'Resume retained task',
    description:
      'Resume a paused or failed task after inspecting its blocker and retained work. ' +
      'Reuses the candidate and starts fresh orchestration with current instructions. ' +
      'Conflicting ownership is rejected. Explicitly cancelled work needs a new user request. ' +
      otherCheckout,
    parameters: Type.Object({ id: idSchema, project: Type.Optional(projectSchema) }),
    async execute(_id, args, _signal, _update, ctx) {
      const origin = taskOrigin(ctx)
      const jobs = new Delegations(await taskStore(ctx, args.project))
      requireOwnTask(await jobs.get(args.id), origin.session, args.project)
      feed.reopen(args.id)
      return textResult(delegationView(await jobs.resume(args.id, origin, launch)))
    },
  })
}
