import { realpath } from 'node:fs/promises'
import type {
  AgentBeforeSettleEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import {
  AssignmentStore,
  applyUpdate,
  assignmentContext,
  assignmentLimits,
  assignmentStates,
  assignmentsView,
  blockUndelivered,
  confirmForeignStop,
  confirmTaskCancel,
  confirmedStops,
  describeAssignment,
  holderOf,
  importLegacy,
  isOpen,
  observeSources,
  resumeUndelivered,
  runKey,
  sourceLabel,
  stallHost,
  stopCommand,
  taskKey,
  type Assignment,
  type AssignmentLedger,
  type AssignmentSource,
  type AssignmentState,
  type Confirmation,
  type Observation,
  type StopAction,
} from './assignments.ts'
import { Delegations, activeTask, type DelegationRequest } from './delegation-state.ts'
import { DeliveryLedger, deliveryLimits, liveSession, type DeliveryLimits } from './delivery.ts'
import { textResult } from './file-tools.ts'
import type { RunWatches } from './github-run-watch.ts'
import { invariant } from './invariant.ts'
import { StateStore } from './state.ts'
import { WorkerRoots } from './worker-roots.ts'

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' })
const taskId = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' })
const retry = Type.Object(
  { blocker: text(400), resumeWhen: text(400) },
  { additionalProperties: false },
)
const sourceInput = Type.Object(
  {
    task: Type.Optional(taskId),
    project: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    repository: Type.Optional(Type.String({ minLength: 3, maxLength: 140 })),
    runId: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  },
  { additionalProperties: false },
)
const parameters = Type.Object({
  state: Type.Union(assignmentStates.map((state) => Type.Literal(state))),
  detail: Type.String({ minLength: 1, maxLength: 800 }),
  assignment: Type.Optional(Type.String({ pattern: '^a[1-9][0-9]{0,8}$' })),
  outcome: Type.Optional(text(400)),
  target: Type.Optional(text(200)),
  owner: Type.Optional(text(120)),
  sources: Type.Optional(Type.Array(sourceInput, { maxItems: 8 })),
  evidence: Type.Optional(
    Type.Object(
      { target: text(200), revision: text(200), summary: Type.Optional(text(600)) },
      { additionalProperties: false },
    ),
  ),
  retry: Type.Optional(retry),
})
type HostWorkInput = Omit<Static<typeof parameters>, 'state'> & { state: AssignmentState }

// The entry the earlier latest-per-branch scheme wrote. Still appended as the transcript trail.
const legacyRecord = Type.Object({
  state: Type.String(),
  detail: Type.String(),
  retry: Type.Optional(retry),
  session: Type.String(),
})
const recordType = 'pi-host-work'
const followUp = 'pi-host-work-next'
const contextType = 'pi-host-work-context'

// Records as last read or written, for synchronous readers. One entry per live session.
const snapshots = new Map<string, AssignmentLedger>()

/**
 * What the user's latest message on this branch confirms. A user-role entry is written only for
 * input the user sent (typed, over RPC or with /steer); no host tool creates one, and a wake,
 * a worker result or a whiteboard request arrives as a custom message. An older message is never
 * consulted: the user's most recent word is the only one that can still be an instruction.
 */
function userConfirmation(ctx: ExtensionContext): Confirmation | undefined {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast((item) => item.type === 'message' && item.message.role === 'user')

  if (entry?.type !== 'message' || entry.message.role !== 'user') {
    return undefined
  }

  const content = entry.message.content
  const said =
    typeof content === 'string'
      ? content
      : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  return { by: 'message:' + entry.id, stops: confirmedStops(said) }
}

/**
 * Whether the user stopped everything this session recorded: it has open assignments and each
 * one is paused. Automatic wakes that are bound to no assignment stay parked only then. Pausing
 * one assignment never quiets the session for the others, whichever changed last. A session
 * whose records are not loaded falls back to the trail entry on its current branch, which is
 * how an earlier version recorded a pause.
 */
export function hostWorkPaused(ctx: ExtensionContext) {
  const session = ctx.sessionManager.getSessionId()
  const ledger = snapshots.get(session)

  if (!ledger) {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (item) =>
          item.type === 'custom' &&
          item.customType === recordType &&
          Check(legacyRecord, item.data) &&
          item.data.session === session,
      )
    return (
      entry?.type === 'custom' && Check(legacyRecord, entry.data) && entry.data.state === 'paused'
    )
  }

  const open = ledger.records.filter(isOpen)
  return open.length > 0 && open.every((record) => record.state === 'paused')
}

/** A task as its registry records it: its ID and the sessions and checkouts it reports to. */
export type TaskOwner = Pick<
  DelegationRequest,
  'id' | 'root' | 'session' | 'originSession' | 'originRoot'
>

/** A task one of this session's open assignments is bound to. */
export type BoundTask = {
  id: string
  project: string
  assignment: string
  outcome: string
  target?: string
}

export type DeskOptions = {

  /** Registered GitHub run watches, when the watch tool is loaded. */
  watches?: RunWatches

  /** Reconciliation period while assignments are open. */
  tickMs?: number
  delivery?: DeliveryLimits
}

/**
 * Keeps one session's assignments consistent with their registered sources and makes sure the
 * host learns when one is handed back to it. Every pass is bounded and uses no model call.
 */
export class AssignmentDesk {
  current: ExtensionContext | undefined
  private closed = false
  private busy = false
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly stores = new Map<string, Promise<AssignmentStore>>()

  /** The change (seq) of each record the model has been shown or wrote itself. */
  private readonly presented = new Map<string, number>()

  /** Consecutive unreadable observations per source. */
  private readonly failures = new Map<string, number>()

  /**
   * The assignments the running host turn was explicitly asked to continue: those named by the
   * continuation that started the run or that its last settlement appended. Undefined while the
   * run answers anything else. A run that ends in an error, or that answers the continuation
   * without action, is attributed to these and no others.
   */
  private continuing: readonly string[] | undefined

  /**
   * Active assignments offered to the host once more after a run error nothing attributed. One
   * offer per assignment until a run completes; at most the open bound are held.
   */
  private readonly reoffered = new Set<string>()

  /** /assignments stops applied by this process; each is its own confirmation. */
  private commands = 0
  private wakes: DeliveryLedger
  private readonly limits: DeliveryLimits

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: DeskOptions = {},
  ) {
    this.limits = options.delivery ?? deliveryLimits
    this.wakes = new DeliveryLedger(this.limits)
  }

  /** Load the session's records before its first turn, tick or synchronous reader. */
  async open(ctx: ExtensionContext) {
    this.closed = false
    this.current = ctx
    this.observe()
    await this.store(ctx)
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    this.timer = undefined

    for (const session of this.stores.keys()) {
      snapshots.delete(session)
    }

    this.stores.clear()
    this.presented.clear()
    this.failures.clear()
    this.reoffered.clear()
    this.continuing = undefined
    this.wakes = new DeliveryLedger(this.limits)
  }

  /** Reconcile periodically so a result reaches the host even when its wake was dropped. */
  observe() {
    if (this.timer) {
      return
    }

    this.timer = setInterval(() => {
      if (this.current && !this.closed) {
        void this.tick(this.current).catch((error: unknown) => this.stopObserving(error))
      }
    }, this.options.tickMs ?? 1000)
    this.timer.unref()
  }

  private stopObserving(error: unknown) {
    this.close()

    try {
      this.current?.ui.setStatus(
        'pi-assignments',
        `Assignment observer stopped; reload to resume: ${String(error).slice(0, 120)}`,
      )
    } catch {
      // SDK disposal can invalidate a context without emitting session_shutdown.
    }
  }

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

  private store(ctx: ExtensionContext): Promise<AssignmentStore> {
    const session = ctx.sessionManager.getSessionId()
    let store = this.stores.get(session)

    if (!store) {

      // A failed load is reported to its caller and tried again by the next one.
      store = this.load(ctx, session).catch((error: unknown) => {
        this.stores.delete(session)
        throw error
      })
      this.stores.clear()
      this.stores.set(session, store)
    }

    return store
  }

  private async load(ctx: ExtensionContext, session: string): Promise<AssignmentStore> {
    const origin = await realpath(ctx.sessionManager.getHeader?.()?.cwd ?? ctx.cwd)
    const store = new AssignmentStore(new StateStore(origin).directory, session)

    if (!(await store.exists())) {
      await this.adoptLegacy(ctx, store, session)
    }

    // Records that existed when this process opened the session are not news to wake for.
    for (const record of (await store.read()).records) {
      this.presented.set(record.id, record.seq)
    }

    this.publish(store)
    return store
  }

  /** Bring forward host work an earlier version recorded as the latest entry on this branch. */
  private async adoptLegacy(ctx: ExtensionContext, store: AssignmentStore, session: string) {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (item) =>
          item.type === 'custom' &&
          item.customType === recordType &&
          Check(legacyRecord, item.data) &&
          item.data.session === session &&
          !('assignment' in item.data),
      )

    if (entry?.type !== 'custom' || !Check(legacyRecord, entry.data)) {
      return
    }

    const legacy = entry.data
    const sources: AssignmentSource[] = []
    const mentioned = legacy.detail.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g) ?? []

    for (const id of new Set(mentioned.slice(0, 8))) {
      try {
        sources.push(await this.taskSource(ctx, session, id))
      } catch {
        // The text named something that is not a tracked task of this session.
      }
    }

    await store.mutate((ledger) => importLegacy(ledger, legacy, sources, new Date()))
  }

  private publish(store: AssignmentStore) {
    if (store.snapshot) {
      snapshots.delete(store.session)
      snapshots.set(store.session, store.snapshot)
    }
  }

  /** Tasks bound to this session's open assignments, from the records already in memory. */
  boundTasks(session: string): BoundTask[] {
    const records = snapshots.get(session)?.records ?? []
    return records.filter(isOpen).flatMap((record) =>
      record.sources.flatMap((source) =>
        source.kind === 'task'
          ? [
              {
                id: source.id,
                project: source.project,
                assignment: record.id,
                outcome: record.outcome,
                target: record.target,
              },
            ]
          : [],
      ),
    )
  }

  private async taskSource(
    ctx: ExtensionContext,
    session: string,
    id: string,
    project?: string,
  ): Promise<AssignmentSource> {
    const roots = project ? [await realpath(project)] : [await realpath(ctx.cwd)]

    if (!project) {
      const origin = await realpath(ctx.sessionManager.getHeader?.()?.cwd ?? ctx.cwd)

      try {
        for (const entry of await new WorkerRoots(new StateStore(origin)).entries()) {
          if (entry?.taskId === id && entry.session === session && !roots.includes(entry.root)) {
            roots.push(entry.root)
          }
        }
      } catch {
        // An unreadable origin index only removes the shortcut; name the project explicitly.
      }
    }

    for (const root of roots) {
      let job

      try {
        job = await new Delegations(new StateStore(root, undefined, false)).get(id)
      } catch {
        continue
      }

      if (job.request.session !== session && job.request.originSession !== session) {
        throw new Error(`Task ${id} belongs to another session and cannot wake this one`)
      }

      return { kind: 'task', key: taskKey(id), id, project: root }
    }

    throw new Error(
      `No tracked task ${id}${project ? ' in ' + project : ''}. Dispatch it through a task ` +
        'tool first; an untracked process cannot wake this session.',
    )
  }

  private async source(
    ctx: ExtensionContext,
    session: string,
    input: Static<typeof sourceInput>,
  ): Promise<AssignmentSource> {
    const run = input.repository !== undefined || input.runId !== undefined

    if (input.task && !run) {
      return this.taskSource(ctx, session, input.task, input.project)
    }

    if (!input.task && input.repository && input.runId !== undefined && !input.project) {
      const repository = input.repository.toLowerCase()
      const watch = this.options.watches?.find(ctx, repository, input.runId)

      if (!watch) {
        throw new Error(
          `No watch is registered for ${repository} run ${input.runId}. Register it with ` +
            'watch_github_run first; a status lookup cannot wake this session.',
        )
      }

      return { kind: 'run', key: runKey(watch), watch, repository, runId: input.runId }
    }

    throw new Error(
      'A source is a tracked task (task, optional project) or a watched GitHub run ' +
        '(repository and runId)',
    )
  }

  /** Read each source's state from its own registry. Three unreadable passes settle it. */
  private async observed(ctx: ExtensionContext, sources: AssignmentSource[]) {
    const observed = new Map<string, Observation>()

    for (const source of sources) {
      let seen: Observation | undefined

      try {
        if (source.kind === 'task') {
          const store = new StateStore(source.project, undefined, false)
          const { state } = await new Delegations(store).get(source.id)
          seen = {
            status: state.status,
            terminal: !activeTask(state),
            version: state.deliveryVersion ?? 0,
          }
        } else {
          const state = this.options.watches?.state(ctx, source.watch)
          seen = state && { ...state, version: 0 }
        }
      } catch {
        // Counted below: a source that stays unreadable is reported, not waited on forever.
      }

      if (seen) {
        this.failures.delete(source.key)
        observed.set(source.key, seen)
        continue
      }

      const failures = (this.failures.get(source.key) ?? 0) + 1
      this.failures.set(source.key, failures)

      if (failures >= 3) {
        observed.set(source.key, { status: 'unavailable', terminal: true, version: -1 })
      }
    }

    return observed
  }

  /** Bring the records up to date with their sources. Idempotent. */
  async reconcile(ctx: ExtensionContext, includeSettled = true): Promise<AssignmentLedger> {
    const store = await this.store(ctx)
    const sources = (await store.read()).records
      .filter(isOpen)
      .flatMap((record) => record.sources)
      .filter((source) => includeSettled || !source.settled)

    if (sources.length) {
      const observed = await this.observed(ctx, sources)
      await store.mutate((ledger) => observeSources(ledger, observed, new Date()))
      this.publish(store)
    }

    return store.read()
  }

  private wakeKey(session: string, record: Assignment) {
    return `${session}:${record.id}:${record.seq}`
  }

  /**
   * One pass: reconcile, then wake the idle host for an assignment that was handed back to it
   * and that no turn has shown the model. The source's own notification goes first; this wake
   * follows after a grace period and repeats with the same bounded backoff.
   */
  async tick(ctx: ExtensionContext) {
    const session = this.busy ? undefined : this.owned(ctx)

    if (session === undefined) {
      return
    }

    this.busy = true

    try {
      const store = await this.store(ctx)

      if (!(await store.read()).records.some(isOpen)) {
        return
      }

      const ledger = await this.reconcile(ctx, false)
      const root = await realpath(ctx.cwd)

      // The session can end while the reads are pending. From here to the wake, the pass
      // yields only to record a blocker, and then returns.
      if (this.owned(ctx) !== session) {
        return
      }

      const now = Date.now()
      const unseen = ledger.records.filter(
        (record) => record.state === 'active' && record.seq > (this.presented.get(record.id) ?? -1),
      )
      const spent = new Set(this.wakes.exhausted(now))
      const undelivered = unseen.filter((record) => spent.has(this.wakeKey(session, record)))

      if (undelivered.length) {
        const ids = undelivered.map((record) => record.id)
        await store.mutate((draft) => blockUndelivered(draft, ids, new Date()))
        this.publish(store)
        ctx.ui.notify(
          `Assignment ${ids.join(', ')}: the host could not be woken after ` +
            `${this.limits.attempts} attempts. The work is recorded and continues on the ` +
            'next turn; /assignments shows it.',
          'warning',
        )
        return
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return
      }

      const due = unseen.filter(
        (record) =>
          now - Date.parse(record.updatedAt) >= 2 * this.limits.retryMs &&
          this.wakes.dueWhileIdle(this.wakeKey(session, record), now),
      )

      if (!due.length) {
        return
      }

      for (const record of due) {
        this.wakes.offer(this.wakeKey(session, record), now)
      }

      this.pi.sendMessage(
        {
          customType: followUp,
          display: false,
          content: continuation(due, root),
          details: { assignments: due.map((record) => record.id) },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      )
    } finally {
      this.busy = false
    }
  }

  /**
   * The compact context for a starting turn. The turn itself acknowledges every wake. A run
   * started by a continuation answers for the assignments that continuation names; a run
   * started by the user or by any other message answers for none.
   */
  async turnContext(ctx: ExtensionContext, event?: BeforeAgentStartEvent) {
    this.current = ctx
    this.continuing = event && continuedBy(event)
    const store = await this.store(ctx)
    await this.reconcile(ctx)
    await store.mutate((ledger) => resumeUndelivered(ledger, new Date()))
    this.publish(store)
    const ledger = await store.read()
    this.wakes = new DeliveryLedger(this.limits)

    for (const record of ledger.records) {
      this.presented.set(record.id, record.seq)
    }

    const content = assignmentContext(ledger, await realpath(ctx.cwd))
    return content ? { message: { customType: contextType, display: false, content } } : undefined
  }

  async view(ctx: ExtensionContext): Promise<string> {
    return assignmentsView(await this.reconcile(ctx), await realpath(ctx.cwd))
  }

  /**
   * The open assignment of another session that task advances, described for a refusal. The
   * records are read where the owning session keeps them: beside the checkout it started in.
   * At most two sessions in two checkouts are consulted. A checkout that no longer exists holds
   * no records; records that exist and cannot be read throw.
   */
  private async foreignHolder(session: string, task: TaskOwner): Promise<string | undefined> {
    const owners = new Set([task.originSession, task.session])
    const roots = new Set([task.originRoot ?? task.root, task.root])

    for (const owner of owners) {
      if (owner === undefined || owner === session) {
        continue
      }

      for (const root of roots) {
        let origin: string

        try {
          origin = await realpath(root)
        } catch {

          // A removed checkout has no session reading records from it.
          continue
        }

        const directory = new StateStore(origin, undefined, false).directory
        const holder = holderOf(await new AssignmentStore(directory, owner).read(), task.id)

        if (holder) {
          return `assignment ${holder.id} (${holder.outcome}) of session ${owner}`
        }
      }
    }

    return undefined
  }

  /**
   * Before task_control pauses or cancels a task for the host. Cancelling a task bound to one of
   * this session's open assignments needs the user's confirmation naming that assignment or the
   * task; pausing it is the host's own repartition and returns the assignment to the host. A
   * task that advances another session's open assignment is not this host's to stop: either
   * action needs the user's confirmation naming the task. Each use is recorded, so one
   * confirmation stops it once. Any other task is controlled as before. Unreadable records
   * refuse the stop rather than allow it.
   */
  async authorizeTaskStop(ctx: ExtensionContext, action: StopAction, task: TaskOwner) {
    const store = await this.store(ctx)
    const confirmation = userConfirmation(ctx)
    const own = holderOf(await store.read(), task.id) !== undefined
    const foreign = own ? undefined : await this.foreignHolder(store.session, task)

    if (!foreign && action === 'pause') {
      return
    }

    await store.mutate((ledger) => {
      if (foreign) {
        confirmForeignStop(ledger, action, task.id, foreign, confirmation, new Date())
      } else {
        confirmTaskCancel(ledger, task.id, confirmation, new Date())
      }
    })
    this.publish(store)
  }

  /**
   * The user's /assignments pause or cancel: their own act on the one record they named. The
   * recorded next step is kept, and the host learns of the change without a turn being started.
   */
  async stop(ctx: ExtensionContext, action: StopAction, id: string): Promise<string> {
    const store = await this.store(ctx)
    const current = (await store.read()).records.find((record) => record.id === id)

    if (!current) {
      throw new Error(`No assignment ${id} in this session; /assignments lists them.`)
    }

    this.commands++
    const state = action === 'pause' ? 'paused' : 'cancelled'
    const result = await this.record(
      ctx,
      { assignment: id, state, detail: current.next },
      {
        by: `command:${new Date().toISOString()}#${this.commands}`,
        stops: [{ action, target: id }],
      },
    )
    const subject = `assignment ${id} (${result.outcome} → ${result.target ?? 'no target'})`
    this.pi.sendMessage(
      {
        customType: 'pi-assignment-stop',
        display: false,
        content:
          `The user ${state} ${subject} with /assignments. ` +
          (action === 'pause'
            ? 'Leave it paused until the user asks to continue it; its running sources finish ' +
              'their current attempt. '
            : 'It is withdrawn and its running sources were asked to stop. Do not restart it ' +
              'without a new request. ') +
          'No other assignment changed: keep advancing the others.',
        details: { assignment: id, state },
      },
      { triggerTurn: false },
    )
    return (
      `${state === 'paused' ? 'Paused' : 'Cancelled'} ${subject}.` +
      (result.released?.length ? '\n' + result.released.join('\n') : '')
    )
  }

  /** Stop exactly the sources of one cancelled assignment and say what happened to each. */
  private async release(sources: AssignmentSource[]): Promise<string[]> {
    const released: string[] = []

    for (const source of sources) {
      const label = sourceLabel(source)

      if (source.kind === 'run') {
        const withdrawn = this.options.watches?.withdraw(source.watch)
        released.push(`${label}: ${withdrawn ? 'local watch withdrawn' : 'no pending watch'}`)
        continue
      }

      try {
        const store = new StateStore(source.project, undefined, false)
        await new Delegations(store).control(source.id, 'cancel')
        released.push(`${label}: cancellation requested`)
      } catch (error) {
        released.push(`${label}: not cancelled (${String(error).slice(0, 160)})`)
      }
    }

    return released
  }

  /**
   * One host_work call, or one /assignments stop with the user's command as its confirmation.
   * A host_work call is confirmed only by the user's latest message, whatever the call says.
   */
  async record(
    ctx: ExtensionContext,
    input: HostWorkInput,
    confirmation: Confirmation | undefined = userConfirmation(ctx),
  ) {
    const session = ctx.sessionManager.getSessionId()
    const store = await this.store(ctx)
    await this.reconcile(ctx)
    const sources: AssignmentSource[] = []

    for (const item of input.sources ?? []) {
      sources.push(await this.source(ctx, session, item))
    }

    const observed = await this.observed(ctx, sources)
    const { result, previous } = await store.mutate((ledger) => {
      const before = structuredClone(ledger.records)
      const applied = applyUpdate(ledger, { ...input, sources, confirmation }, observed, new Date())
      return {
        result: applied,
        previous: before.find((record) => record.id === applied.record.id)?.blocker,
      }
    })
    const { record } = result
    this.publish(store)
    this.presented.set(record.id, record.seq)
    this.pi.appendEntry(recordType, {
      assignment: record.id,
      state: record.state,
      detail: record.next,
      ...(record.blocker && { retry: record.blocker }),
      session,
    })

    if (
      record.blocker &&
      (previous?.blocker !== record.blocker.blocker ||
        previous.resumeWhen !== record.blocker.resumeWhen)
    ) {
      this.pi.sendMessage(
        {
          customType: 'pi-host-work-blocker',
          display: true,
          content:
            `${record.outcome} (${record.id})\n${record.blocker.blocker}\n` +
            `Resume condition · ${record.blocker.resumeWhen}`,
        },
        { triggerTurn: false },
      )
    }

    const released = await this.release(result.release)
    return {
      assignment: record.id,
      state: record.state,
      owner: record.owner,
      outcome: record.outcome,
      target: record.target,
      next: record.next,
      attempts: record.attempts,
      sources: record.sources.map(
        (source) => `${sourceLabel(source)} ${source.settled?.status ?? 'running'}`,
      ),
      ...(result.notes.length && { notes: result.notes }),
      ...(released.length && { released }),
    }
  }

  /** Whether the model was shown this record, or wrote it, in its current state. */
  private shown(record: Assignment): boolean {
    return record.seq <= (this.presented.get(record.id) ?? -1)
  }

  /**
   * A host run that ended in an error. The assignments its continuation named were being
   * advanced by that run and say so. No other record changes: an error nothing attributes
   * belongs to the session, not to work the run was never asked about. Each such assignment
   * is offered to the host once more, after the first retry delay, and a second error in the
   * same streak leaves it active for the next turn instead of offering it again.
   */
  private async settleError(
    ctx: ExtensionContext,
    store: AssignmentStore,
    active: Assignment[],
    named: readonly string[],
  ) {
    const responsible = active.filter((record) => named.includes(record.id))
    const others = active.filter((record) => !named.includes(record.id))

    if (responsible.length) {
      const ids = responsible.map((record) => record.id)
      await store.mutate((draft) =>
        stallHost(draft, ids, new Date(), 'The host run ended with an error.'),
      )
      this.publish(store)
    }

    for (const id of [...this.reoffered]) {
      if (!others.some((record) => record.id === id)) {
        this.reoffered.delete(id)
      }
    }

    const again = others.filter((record) => !this.reoffered.has(record.id))
    const now = Date.now()

    for (const record of again) {

      // The failed run counts as the first offer, so the next pass waits one retry delay.
      this.reoffered.add(record.id)
      this.presented.delete(record.id)
      this.wakes.offer(this.wakeKey(store.session, record), now)
    }

    invariant(this.reoffered.size <= assignmentLimits.open, 'reoffers exceed open assignments')

    if (others.length) {
      const ids = (records: Assignment[]) => records.map((record) => record.id).join(', ')
      ctx.ui.notify(
        `The host run ended with an error. Still active and unchanged: ${ids(others)}. ` +
          (again.length
            ? `Offering ${ids(again)} to the host once more. `
            : 'They continue on the next turn. ') +
          '/assignments shows them.',
        'warning',
      )
    }
  }

  /**
   * Decide at settlement whether the host still owns a step it can take now. A run answers
   * only for what it was asked: an error, or a continuation answered without action, stalls
   * the assignments that continuation named and no others. A named assignment that changed
   * while the run was under way has news the model was not shown, and an active assignment
   * the continuation did not name was never put to the host: both are continued instead of
   * blocked. When no continuation of this run names anything, nothing stalls.
   */
  async settle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {

    // The identity covers one settlement: what follows is asked again here or is not ours.
    const named = this.continuing ?? []
    this.continuing = undefined

    if (event.outcome === 'completed') {
      this.reoffered.clear()
    }

    const store = await this.store(ctx)
    const ledger = await this.reconcile(ctx)
    const active = ledger.records.filter((record) => record.state === 'active')

    if (!active.length) {
      return undefined
    }

    // An interrupt stops this turn and nothing else. It names no assignment, so no record is
    // paused, and no continuation follows it: the records stay as they are for the next turn.
    if (event.outcome === 'aborted') {
      return undefined
    }

    if (event.outcome !== 'completed') {
      await this.settleError(ctx, store, active, named)
      return undefined
    }

    if (event.continue || event.context.pendingMessages.length) {
      return undefined
    }

    const root = await realpath(ctx.cwd)
    const stalled = continuedWithoutAction(event)
      ? active.filter((record) => named.includes(record.id) && this.shown(record))
      : []
    const ready = active.filter((record) => !stalled.includes(record))
    const entries = [...event.entries]

    if (stalled.length) {
      const ids = stalled.map((record) => record.id)
      await store.mutate((draft) => stallHost(draft, ids, new Date()))
      this.publish(store)
      entries.push({
        type: 'custom_message' as const,
        customType: 'pi-host-work-stalled',
        display: true,
        content:
          'Host work stopped after a continuation produced no action.\n' +
          stalled.map((record) => describeAssignment(record, root)).join('\n'),
        details: { assignments: ids },
      })
    }

    if (!ready.length) {
      return { entries }
    }

    // Each continuation marks what it names as shown and is the identity the next settlement
    // answers for, so a record is put to the host once per change and a run of answers
    // without action ends within the open bound.
    for (const record of ready) {
      this.presented.set(record.id, record.seq)
    }

    this.continuing = ready.map((record) => record.id)
    entries.push({
      type: 'custom_message' as const,
      customType: followUp,
      display: false,
      content: continuation(ready, root),
      details: { assignments: this.continuing },
    })
    return { entries, continue: true }
  }
}

/** The assignments named by the continuation that starts a run, if a continuation starts it. */
function continuedBy(event: BeforeAgentStartEvent): string[] | undefined {
  if (event.messageType !== 'custom' || event.message.customType !== followUp) {
    return undefined
  }

  const named = (event.message.details as { assignments?: unknown } | undefined)?.assignments

  if (!Array.isArray(named)) {
    return undefined
  }

  return named.filter((id): id is string => typeof id === 'string').slice(0, assignmentLimits.open)
}

function continuation(records: Assignment[], root: string): string {
  invariant(records.length > 0, 'a continuation names at least one assignment')
  return (
    'The host owns the next step of these authorized assignments:\n' +
    records.map((record) => describeAssignment(record, root)).join('\n') +
    '\nTake the next available action on each now. Reconcile the current state before ' +
    'repeating a side effect. Record with host_work when one is delivered (evidence for its ' +
    'target and revision), waiting on a registered source, blocked or stopped. A candidate or ' +
    'preview is not delivery. Honor newer user input.'
  )
}

/** The previous continuation was answered without any tool action besides bookkeeping. */
function continuedWithoutAction(event: AgentBeforeSettleEvent): boolean {
  const messages = event.context.contextMessages

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (
      message.role === 'user' ||
      (message.role === 'toolResult' && message.toolName !== 'host_work')
    ) {
      return false
    }

    if (message.role === 'custom' && message.customType === followUp) {
      return true
    }
  }

  return false
}

function registerHostWorkTool(pi: ExtensionAPI, desk: AssignmentDesk) {
  pi.registerTool({
    name: 'host_work',
    label: 'Track assignments',
    description:
      'Record an authorized assignment and keep it moving to delivery. Open one with outcome, ' +
      'target (where the user authorized delivery) and state; the result returns its ID. Pass ' +
      'assignment to update it; several can be open at once and none replaces another. ' +
      'detail is the next step. Use active while you own that step. Use waiting only with ' +
      'sources: tracked task IDs (add project for a task in another checkout) or a run ' +
      'registered with watch_github_run; a source that already finished keeps the assignment ' +
      'active. Use blocked with retry.blocker (what is missing and who owns it) and ' +
      'retry.resumeWhen for a dependency nothing here can observe. paused and cancelled are ' +
      "accepted only on the user's own confirmation naming that assignment: a line of their " +
      'latest message that reads "pause aN" or "cancel aN". An interrupt, a new request, a ' +
      'change of priority or your own judgement never pauses or cancels one, and nothing you ' +
      'pass substitutes for that line; when the user asks in other words, ask them for it or ' +
      'for /assignments pause aN or /assignments cancel aN. cancelled also stops that ' +
      "assignment's running sources and nothing else. done requires evidence " +
      'with the delivered revision on the authorized target; a candidate or preview does not ' +
      'close an assignment. Set retry on active work at the first operational retry.',
    parameters,
    async execute(_id, input, _signal, _update, ctx) {
      return textResult(await desk.record(ctx, input))
    },
  })
}

function registerAssignmentsCommand(pi: ExtensionAPI, desk: AssignmentDesk) {
  pi.registerCommand('assignments', {
    description: 'Show the recorded assignments; "pause aN" or "cancel aN" stops exactly that one',
    async handler(args, ctx) {
      const request = args.trim()

      if (!request) {
        ctx.ui.notify(await desk.view(ctx), 'info')
        return
      }

      const match = stopCommand.exec(request)

      if (!match) {
        ctx.ui.notify(
          'Usage: /assignments, /assignments pause aN or /assignments cancel aN. ' +
            'Nothing changed.',
          'warning',
        )
        return
      }

      const action = match[1]!.toLowerCase() as StopAction

      try {
        ctx.ui.notify(await desk.stop(ctx, action, match[2]!.toLowerCase()), 'info')
      } catch (error) {

        // An invalid request is reported to the user who typed it; no record changed.
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })
}

function registerAssignmentHooks(pi: ExtensionAPI, desk: AssignmentDesk) {
  pi.on('session_start', (_event, ctx) => desk.open(ctx))
  pi.on('session_shutdown', () => desk.close())
  pi.on('before_agent_start', (event, ctx) => desk.turnContext(ctx, event))
  pi.on('agent_before_settle', (event, ctx) => desk.settle(event, ctx))

  // Each turn restates the records; only the newest statement belongs in model context.
  pi.on('context', ({ messages }) => {
    const stated = (index: number) => {
      const message = messages[index]!
      return message.role === 'custom' && message.customType === contextType
    }
    const latest = messages.findLastIndex((_message, index) => stated(index))
    const kept = messages.filter((_message, index) => index === latest || !stated(index))
    return kept.length === messages.length ? undefined : { messages: kept }
  })
}

export function registerHostWork(pi: ExtensionAPI, options: DeskOptions = {}): AssignmentDesk {
  const desk = new AssignmentDesk(pi, options)
  registerAssignmentHooks(pi, desk)
  registerHostWorkTool(pi, desk)
  registerAssignmentsCommand(pi, desk)
  desk.observe()
  return desk
}
