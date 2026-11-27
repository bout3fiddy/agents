import { join } from 'node:path'
import { invariant } from './invariant.ts'
import { digest } from './paths.ts'
import { atomicJson, readJson } from './state.ts'

/**
 * Assignment records: what the host is authorized to deliver, to which target, who advances it
 * next and what has been tried. One bounded ledger per session, stored beside the other harness
 * state. Nothing here reads the conversation, so navigating the session tree, answering a side
 * question, interrupting a turn or starting other work cannot replace, pause or cancel a record.
 * Pausing or cancelling one takes the user's own confirmation naming it, supplied by the caller.
 */
export const assignmentLimits = {

  /** Open assignments one session may hold. A full ledger rejects a new one. */
  open: 12,

  /** Records kept per session. The oldest closed records are dropped first. */
  retained: 48,

  /** Wake sources bound to one assignment. Settled sources are evicted first. */
  sources: 8,

  /** Settled attempts kept for inspection; the count itself is never truncated. */
  history: 8,

  /** Evidence entries kept per assignment. */
  evidence: 4,

  /**
   * Used confirmations remembered per assignment. One message can stop the assignment twice
   * (pause, cancel) and each of its eight sources once, so this covers every use of one message.
   * The same bound holds the uses a session remembers for tasks of other sessions: one message
   * confirms at most `stops` of them.
   */
  confirmed: 16,

  /** Lines of one user message read for confirmations, and the longest line considered. */
  confirmationLines: 512,
  confirmationLineLength: 200,

  /** Stops one message or command can confirm. */
  stops: 16,
} as const

export const assignmentStates = [
  'active',
  'waiting',
  'blocked',
  'paused',
  'done',
  'cancelled',
] as const
export type AssignmentState = (typeof assignmentStates)[number]

export type StopAction = 'pause' | 'cancel'

/**
 * The user's own confirmation that named work may stop: one message or one /assignments command.
 * `by` identifies it and `stops` lists exactly what it names, an assignment ID or a task ID. It
 * is the only authority to pause or cancel recorded work. A new request, an interrupt, a status
 * question and the host's own reasoning are not, and the host cannot supply one.
 */
export type Confirmation = { by: string; stops: { action: StopAction; target: string }[] }

/** One use of a confirmation: it stopped subject (the assignment or one of its tasks) once. */
export type ConfirmedStop = { action: StopAction; subject: string; by: string; at: string }

/** The terminal state a wake source was observed in, at one delivery version. */
export type Settlement = { status: string; version: number; at: string }

/** A registered source that can wake the host: a tracked task or a GitHub run watch. */
export type AssignmentSource =
  | { kind: 'task'; key: string; id: string; project: string; settled?: Settlement }
  | {
      kind: 'run'
      key: string
      watch: string
      repository: string
      runId: number
      settled?: Settlement
    }

export type AssignmentBlocker = {
  blocker: string
  resumeWhen: string
  kind?: 'stalled' | 'delivery' | 'legacy'
}

/** Evidence names the target and revision it covers; only a matching target closes. */
export type AssignmentEvidence = {
  summary: string
  target: string
  revision: string
  at: string
  closes: boolean
}

export type Assignment = {
  id: string

  /** Position in the ledger's change order. The largest is the most recently changed record. */
  seq: number
  outcome: string

  /** The authorized delivery target. Only a record imported from an older session lacks one. */
  target?: string
  state: AssignmentState
  owner: string
  next: string

  /** Why the runtime handed the next step back to the host, until the host records progress. */
  wake?: string
  blocker?: AssignmentBlocker
  sources: AssignmentSource[]
  attempts: number
  history: { source: string; status: string; at: string }[]
  evidence: AssignmentEvidence[]

  /** Confirmations already used on this assignment. Each is good for one stop of each subject. */
  confirmed?: ConfirmedStop[]
  legacy?: true
  createdAt: string
  updatedAt: string
}

export type AssignmentLedger = {
  version: 1
  session: string
  nextId: number
  seq: number
  records: Assignment[]

  /**
   * Confirmations this session used on tasks that advance another session's assignment. The use
   * is kept here because the acting session never writes the other session's records.
   */
  confirmed?: ConfirmedStop[]
}

/** What a registered source currently is, read from its own registry. */
export type Observation = { status: string; terminal: boolean; version: number }
export type Observations = ReadonlyMap<string, Observation>

export type AssignmentUpdate = {
  assignment?: string
  state: AssignmentState
  detail: string
  outcome?: string
  target?: string
  owner?: string
  retry?: { blocker: string; resumeWhen: string }
  sources?: AssignmentSource[]
  evidence?: { summary?: string; target: string; revision: string }

  /** What the user confirmed. Set by the runtime from the user's own input, never by the host. */
  confirmation?: Confirmation
}

export type UpdateResult = {
  record: Assignment
  created: boolean
  notes: string[]

  /** Sources still running when the assignment was cancelled; the caller stops exactly these. */
  release: AssignmentSource[]
}

export const taskKey = (id: string) => 'task:' + id
export const runKey = (watch: string) => 'run:' + watch

export function isOpen(record: Assignment): boolean {
  return record.state !== 'done' && record.state !== 'cancelled'
}

export function emptyLedger(session: string): AssignmentLedger {
  return { version: 1, session, nextId: 1, seq: 0, records: [] }
}

function fold(text: string | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function sourceLabel(source: AssignmentSource, root?: string): string {
  if (source.kind === 'run') {
    return `run ${source.repository}#${source.runId}`
  }

  return `task ${source.id}` + (root && source.project !== root ? ` in ${source.project}` : '')
}

function touch(ledger: AssignmentLedger, record: Assignment, now: Date) {
  ledger.seq++
  record.seq = ledger.seq
  record.updatedAt = now.toISOString()
}

function defaultOwner(record: Assignment): string {
  if (record.state === 'active') {
    return 'host'
  }

  if (record.state === 'waiting') {
    const pending = record.sources.filter((source) => !source.settled)
    return pending.map((source) => sourceLabel(source)).join(', ') || 'host'
  }

  if (record.state === 'paused') {
    return 'user'
  }

  return record.state === 'blocked' ? 'external' : 'closed'
}

/** Record sources that finished and re-arm sources that were started again. */
function settle(record: Assignment, observed: Observations, now: Date): boolean {
  let changed = false

  for (const source of record.sources) {
    const seen = observed.get(source.key)

    if (!seen) {
      continue
    }

    const newer = !source.settled || seen.version > source.settled.version

    if (seen.terminal && newer) {
      source.settled = { status: seen.status, version: seen.version, at: now.toISOString() }
      record.attempts++
      record.history.push({
        source: sourceLabel(source),
        status: seen.status,
        at: source.settled.at,
      })
      record.history = record.history.slice(-assignmentLimits.history)
      changed = true
    } else if (!seen.terminal && source.settled && newer) {
      delete source.settled
      changed = true
    }
  }

  return changed
}

function settledSummary(record: Assignment): string {
  return record.sources
    .filter((source) => source.settled)
    .map((source) => `${sourceLabel(source)} ${source.settled!.status}`)
    .join(', ')
}

/**
 * Apply observed source states to every open record. A waiting assignment whose sources have all
 * finished returns to the host as active. Nothing here closes an assignment: a finished worker
 * hands back a candidate, and acceptance stays with the host. Returns the changed record IDs.
 */
export function observeSources(
  ledger: AssignmentLedger,
  observed: Observations,
  now: Date,
): string[] {
  const changed: string[] = []

  for (const record of ledger.records) {
    if (!isOpen(record) || !settle(record, observed, now)) {
      continue
    }

    if (record.state === 'waiting' && record.sources.every((source) => source.settled)) {
      record.state = 'active'
      record.owner = 'host'
      record.wake = `Sources finished: ${settledSummary(record)}`.slice(0, 400)
    } else if (record.state === 'waiting') {
      record.owner = defaultOwner(record)
    }

    touch(ledger, record, now)
    changed.push(record.id)
  }

  return changed
}

function addressed(ledger: AssignmentLedger, update: AssignmentUpdate, now: Date) {
  const open = ledger.records.filter(isOpen)

  if (update.assignment) {
    const record = ledger.records.find((item) => item.id === update.assignment)

    if (!record) {
      const known = ledger.records.map((item) => item.id).join(', ') || 'none'
      throw new Error(`No assignment ${update.assignment} in this session. Known: ${known}`)
    }

    return { record, created: false }
  }

  if (!update.outcome) {
    if (open.length === 1) {
      return { record: open[0]!, created: false }
    }

    throw new Error(
      open.length
        ? `Several assignments are open (${open.map((item) => item.id).join(', ')}). ` +
            'Name one with assignment.'
        : 'No assignment is open. Open one with its authorized outcome and target.',
    )
  }

  if (!update.target) {
    throw new Error('A new assignment names its authorized delivery target')
  }

  if (!['active', 'waiting', 'blocked'].includes(update.state)) {
    throw new Error('Open an assignment as active, waiting or blocked')
  }

  const twin = open.find(
    (item) =>
      fold(item.outcome) === fold(update.outcome) && fold(item.target) === fold(update.target),
  )

  if (twin) {
    throw new Error(
      `Assignment ${twin.id} already tracks this outcome and target. ` +
        `Update it with assignment=${twin.id} instead of opening a duplicate.`,
    )
  }

  if (open.length >= assignmentLimits.open) {
    throw new Error(
      `This session already holds ${assignmentLimits.open} open assignments. ` +
        'Close, cancel or finish one before opening another; /assignments lists them.',
    )
  }

  const at = now.toISOString()
  const record: Assignment = {
    id: 'a' + ledger.nextId,
    seq: 0,
    outcome: update.outcome,
    target: update.target,
    state: update.state,
    owner: 'host',
    next: update.detail,
    sources: [],
    attempts: 0,
    history: [],
    evidence: [],
    createdAt: at,
    updatedAt: at,
  }
  ledger.nextId++
  ledger.records.push(record)
  return { record, created: true }
}

function requireAuthorization(record: Assignment, update: AssignmentUpdate) {
  if (!isOpen(record)) {
    throw new Error(
      `Assignment ${record.id} is closed (${record.state}). ` +
        'Open a new assignment for newly authorized work.',
    )
  }

  if (update.outcome && fold(update.outcome) !== fold(record.outcome)) {
    throw new Error(
      `Assignment ${record.id} is authorized for "${record.outcome}". ` +
        'A different outcome is a new assignment.',
    )
  }

  if (update.target && record.target && fold(update.target) !== fold(record.target)) {
    throw new Error(
      `Assignment ${record.id} delivers to "${record.target}". The target is fixed when ` +
        'the work is authorized; cancel it and open a new assignment for another target.',
    )
  }
}

const assignmentId = 'a[1-9][0-9]{0,8}'
const stopTarget = `(?:${assignmentId}|[a-f0-9]{8}(?:(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?)`

// A whole line and nothing else: "cancel a2", "please pause assignment a1.", "cancel 1a2b3c4d".
// A sentence that merely mentions stopping ("should I cancel a2?", "don't cancel a2") is not one.
const stopLine = new RegExp(
  '^(?:please\\s+)?(pause|cancel)\\s+(?:assignments?\\s+|tasks?\\s+)?' +
    `(${stopTarget}(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)${stopTarget})*)\\s*[.!]?$`,
  'i',
)

/** An /assignments argument that stops one assignment. */
export const stopCommand = new RegExp(`^(pause|cancel)\\s+(${assignmentId})$`, 'i')

/**
 * The stops a user's message confirms. Only a line that is exactly a pause or cancel instruction
 * naming assignment IDs, or tasks by ID or by the first eight characters of one, counts. Natural
 * language is deliberately not interpreted: a misread sentence would stop the wrong work.
 */
export function confirmedStops(text: string): Confirmation['stops'] {
  const stops: Confirmation['stops'] = []

  for (const raw of text.split('\n', assignmentLimits.confirmationLines)) {
    const line = raw.trim()
    const match =
      line.length <= assignmentLimits.confirmationLineLength ? stopLine.exec(line) : null

    if (!match) {
      continue
    }

    const action = match[1]!.toLowerCase() as StopAction

    for (const target of match[2]!.toLowerCase().split(/[\s,]+/)) {
      if (target !== 'and' && stops.length < assignmentLimits.stops) {
        stops.push({ action, target })
      }
    }
  }

  return stops
}

const stopped = { pause: 'paused', cancel: 'cancelled' } as const

/**
 * Use the user's confirmation for one stop of subject, which is record itself or a task bound to
 * it. Throws, leaving the confirmation unused, when the user did not name the subject or its
 * assignment for this action or the confirmation already stopped it once.
 */
function useConfirmation(
  record: Assignment,
  action: StopAction,
  subject: string,
  confirmation: Confirmation | undefined,
  now: Date,
) {
  const task = subject === record.id ? undefined : subject
  const accepted = task ? [record.id, task, task.slice(0, 8)] : [record.id]
  const what = task ? `task ${task} of assignment ${record.id}` : `assignment ${record.id}`
  const unchanged = `Nothing changed: ${what} was not ${stopped[action]}. `
  const named = confirmation?.stops.some(
    (stop) => stop.action === action && accepted.includes(stop.target),
  )

  if (!confirmation || !named) {
    throw new Error(
      unchanged +
        `Recorded work stops only on the user's own confirmation naming it, and the user's ` +
        'latest message does not confirm this. A new request, an interrupt, a status question ' +
        'or your own judgement is not that authority, and unclear instructions never pause ' +
        `work. Keep advancing ${record.id}. If the user did ask for this in other words, ask ` +
        `them to reply with the line "${action} ${record.id}"` +
        (task ? ` (or "${action} ${task.slice(0, 8)}" for this task alone)` : '') +
        ` or to run /assignments ${action} ${record.id}.`,
    )
  }

  const used = record.confirmed ?? []

  if (
    used.some(
      (item) => item.by === confirmation.by && item.action === action && item.subject === subject,
    )
  ) {
    throw new Error(
      unchanged +
        `The user's confirmation was already used to ${action} it once. Doing so again needs ` +
        'a new confirmation from the user.',
    )
  }

  record.confirmed = [
    ...used,
    { action, subject, by: confirmation.by, at: now.toISOString() },
  ].slice(-assignmentLimits.confirmed)
}

/** The open assignment of this ledger that task advances, if any. */
export function holderOf(ledger: AssignmentLedger, task: string): Assignment | undefined {
  return ledger.records.find(
    (item) =>
      isOpen(item) && item.sources.some((source) => source.kind === 'task' && source.id === task),
  )
}

/**
 * Before a task is cancelled on the host's request: a task bound to an open assignment needs
 * the user's confirmation naming that assignment or the task. Returns the assignment, or
 * undefined for a task no open assignment tracks, which is controlled as before.
 */
export function confirmTaskCancel(
  ledger: AssignmentLedger,
  task: string,
  confirmation: Confirmation | undefined,
  now: Date,
): Assignment | undefined {
  const record = holderOf(ledger, task)

  if (record) {
    useConfirmation(record, 'cancel', task, confirmation, now)
  }

  return record
}

/**
 * Before this session pauses or cancels a task that advances an open assignment of another
 * session, described by holder. An assignment ID names the acting session's own records, so
 * only the user's confirmation naming the task itself counts. Each use is recorded in ledger,
 * the acting session's, and is good for one stop. Throws, changing nothing, otherwise.
 */
export function confirmForeignStop(
  ledger: AssignmentLedger,
  action: StopAction,
  task: string,
  holder: string,
  confirmation: Confirmation | undefined,
  now: Date,
) {
  invariant(!holderOf(ledger, task), 'a task of this session follows its own assignment')
  const short = task.slice(0, 8)
  const unchanged = `Nothing changed: task ${task} was not ${stopped[action]}. `
  const named = confirmation?.stops.some(
    (stop) => stop.action === action && (stop.target === task || stop.target === short),
  )

  if (!confirmation || !named) {
    throw new Error(
      unchanged +
        `It advances ${holder}, which this session does not own, and the user's latest ` +
        'message does not confirm this. A new request, an interrupt, tidying up or your own ' +
        'judgement is not that authority, and an assignment ID here names only the records ' +
        'of this session. Leave the task running. If the user did ask for this, ask them to ' +
        `reply with the line "${action} ${short}", or to stop that assignment in its own ` +
        'session with /assignments.',
    )
  }

  const used = ledger.confirmed ?? []

  if (
    used.some(
      (item) => item.by === confirmation.by && item.action === action && item.subject === task,
    )
  ) {
    throw new Error(
      unchanged +
        `The user's confirmation was already used to ${action} it once. Doing so again needs ` +
        'a new confirmation from the user.',
    )
  }

  ledger.confirmed = [
    ...used,
    { action, subject: task, by: confirmation.by, at: now.toISOString() },
  ].slice(-assignmentLimits.confirmed)
}

function bind(ledger: AssignmentLedger, record: Assignment, sources: AssignmentSource[]) {
  for (const source of sources) {
    const holder = ledger.records.find(
      (item) =>
        item !== record && isOpen(item) && item.sources.some((bound) => bound.key === source.key),
    )

    if (holder) {
      throw new Error(
        `${sourceLabel(source)} is already bound to assignment ${holder.id}. ` +
          'One source advances one assignment.',
      )
    }

    if (record.sources.some((bound) => bound.key === source.key)) {
      continue
    }

    if (record.sources.length >= assignmentLimits.sources) {
      const settled = record.sources.findIndex((bound) => bound.settled)

      if (settled < 0) {
        throw new Error(
          `Assignment ${record.id} already waits on ${assignmentLimits.sources} running sources`,
        )
      }

      record.sources.splice(settled, 1)
    }

    record.sources.push(structuredClone(source))
  }
}

function addEvidence(record: Assignment, update: AssignmentUpdate, now: Date) {
  const evidence = update.evidence

  if (!evidence) {
    return undefined
  }

  const entry: AssignmentEvidence = {
    summary: evidence.summary ?? update.detail,
    target: evidence.target,
    revision: evidence.revision,
    at: now.toISOString(),
    closes: record.target === undefined || fold(evidence.target) === fold(record.target),
  }
  record.evidence = [...record.evidence, entry].slice(-assignmentLimits.evidence)
  return entry
}

function requireClosingEvidence(record: Assignment, entry: AssignmentEvidence | undefined) {
  const running = record.sources.filter((source) => !source.settled)

  if (running.length) {
    throw new Error(
      `Assignment ${record.id} still has running sources: ` +
        running.map((source) => sourceLabel(source)).join(', ') +
        '. Wait for them or stop them with task_control before closing.',
    )
  }

  if (record.target === undefined) {
    return
  }

  if (!entry) {
    throw new Error(
      `Closing ${record.id} requires evidence with the delivered revision on its ` +
        `authorized target "${record.target}".`,
    )
  }

  if (!entry.closes) {
    throw new Error(
      `Evidence is for "${entry.target}", but ${record.id} is authorized to deliver to ` +
        `"${record.target}". A candidate, preview or other target does not close it. ` +
        'Record this evidence with state active and continue to the authorized target.',
    )
  }
}

function prune(ledger: AssignmentLedger) {
  const excess = ledger.records.length - assignmentLimits.retained

  if (excess <= 0) {
    return
  }

  const closed = ledger.records
    .filter((record) => !isOpen(record))
    .sort((left, right) => left.seq - right.seq)
    .slice(0, excess)
  ledger.records = ledger.records.filter((record) => !closed.includes(record))
  invariant(ledger.records.length <= assignmentLimits.retained, 'open assignments exceed retention')
}

/**
 * Apply one host_work call. Throws an ordinary error for a request the records cannot honor; the
 * caller applies it to a draft, so a rejected call changes nothing.
 */
export function applyUpdate(
  ledger: AssignmentLedger,
  update: AssignmentUpdate,
  observed: Observations,
  now: Date,
): UpdateResult {
  const { record, created } = addressed(ledger, update, now)
  requireAuthorization(record, update)
  const stop =
    update.state === 'paused' ? 'pause' : update.state === 'cancelled' ? 'cancel' : undefined

  if (stop && record.state !== update.state) {
    useConfirmation(record, stop, record.id, update.confirmation, now)
  }

  if (update.retry && !['active', 'waiting', 'blocked'].includes(update.state)) {
    throw new Error('Report retry conditions only on active, waiting or blocked work')
  }

  if (update.state === 'blocked' && !update.retry) {
    throw new Error(
      'A blocked assignment names its blocker and owner in retry.blocker and the observation ' +
        'that unblocks it in retry.resumeWhen',
    )
  }

  const notes: string[] = []
  bind(ledger, record, update.sources ?? [])
  settle(record, observed, now)
  const pending = record.sources.filter((source) => !source.settled)
  let state = update.state

  if (state === 'waiting' && !record.sources.length) {
    throw new Error(
      'Waiting needs a registered wake source: pass sources with a tracked task ID or a run ' +
        'registered with watch_github_run. For a dependency nothing here can observe, record ' +
        'blocked with its owner and the missing input.',
    )
  }

  if (state === 'waiting' && !pending.length) {
    state = 'active'
    notes.push(
      `Every bound source already finished (${settledSummary(record)}). ` +
        'Nothing is left to wake this assignment, so it stays active: continue now.',
    )
  }

  const entry = addEvidence(record, update, now)

  if (state === 'done') {
    requireClosingEvidence(record, entry)
  }

  record.target ??= update.target
  record.state = state
  record.next = update.detail
  record.blocker = isOpen(record) && state !== 'paused' ? update.retry : undefined
  delete record.wake
  record.owner = update.owner ?? defaultOwner(record)
  touch(ledger, record, now)
  prune(ledger)
  invariant(ledger.records.filter(isOpen).length <= assignmentLimits.open, 'open bound exceeded')
  return { record, created, notes, release: state === 'cancelled' ? pending : [] }
}

function transition(
  ledger: AssignmentLedger,
  now: Date,
  eligible: (record: Assignment) => boolean,
  change: (record: Assignment) => void,
): string[] {
  const changed: string[] = []

  for (const record of ledger.records) {
    if (isOpen(record) && eligible(record)) {
      change(record)
      touch(ledger, record, now)
      changed.push(record.id)
    }
  }

  return changed
}

/**
 * The host run stopped advancing the assignments in ids, the ones that run was answerable for:
 * say so on those records instead of asking again. Every other record is left as it is, so an
 * assignment the run was never asked about stays ready for the host.
 */
export function stallHost(
  ledger: AssignmentLedger,
  ids: readonly string[],
  now: Date,
  blocker = 'A host continuation produced no action.',
): string[] {
  return transition(
    ledger,
    now,
    (record) => record.state === 'active' && ids.includes(record.id),
    (record) => {
      record.state = 'blocked'
      record.owner = 'host'
      record.blocker = {
        kind: 'stalled',
        blocker,
        resumeWhen: 'the host takes the recorded next step or the user redirects it.',
      }
    },
  )
}

/** The host could not be woken for a ready assignment within the delivery bound. */
export function blockUndelivered(ledger: AssignmentLedger, ids: string[], now: Date): string[] {
  return transition(
    ledger,
    now,
    (record) => record.state === 'active' && ids.includes(record.id),
    (record) => {
      record.state = 'blocked'
      record.blocker = {
        kind: 'delivery',
        blocker: 'The host could not be woken for this assignment.',
        resumeWhen: 'the next host turn starts.',
      }
    },
  )
}

/** A host turn is starting, which is exactly what an undelivered wake was waiting for. */
export function resumeUndelivered(ledger: AssignmentLedger, now: Date): string[] {
  return transition(
    ledger,
    now,
    (record) => record.state === 'blocked' && record.blocker?.kind === 'delivery',
    (record) => {
      record.state = 'active'
      record.owner = 'host'
      delete record.blocker
    },
  )
}

/**
 * Carry forward host work recorded by the earlier latest-entry scheme. An active or paused task
 * keeps its state. A wait is kept only when a registered source was found for it; otherwise the
 * record is blocked and visible, never dropped or cancelled.
 */
export function importLegacy(
  ledger: AssignmentLedger,
  legacy: { state: string; detail: string; retry?: { blocker: string; resumeWhen: string } },
  sources: AssignmentSource[],
  now: Date,
): Assignment | undefined {
  if (!['active', 'waiting', 'paused'].includes(legacy.state)) {
    return undefined
  }

  const at = now.toISOString()
  const waiting = legacy.state === 'waiting'
  const record: Assignment = {
    id: 'a' + ledger.nextId,
    seq: 0,
    outcome: legacy.detail.slice(0, 400),
    state: waiting && !sources.length ? 'blocked' : (legacy.state as AssignmentState),
    owner: 'host',
    next: legacy.detail,
    sources: waiting ? sources.slice(0, assignmentLimits.sources) : [],
    attempts: 0,
    history: [],
    evidence: [],
    legacy: true,
    createdAt: at,
    updatedAt: at,
  }

  if (record.state === 'blocked') {
    record.blocker = {
      kind: 'legacy',
      blocker: 'This wait was recorded without a registered wake source.',
      resumeWhen: 'its dependency is confirmed; then record it active or bind a source.',
    }
  } else if (legacy.retry && record.state !== 'paused') {
    record.blocker = legacy.retry
  }

  record.owner = defaultOwner(record)
  ledger.nextId++
  ledger.records.push(record)
  touch(ledger, record, now)
  return record
}

function sourceStatus(source: AssignmentSource, root?: string): string {
  return `${sourceLabel(source, root)} ${source.settled?.status ?? 'running'}`
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
}

/** One record on one line, with every field the next decision needs. */
export function describeAssignment(record: Assignment, root?: string): string {
  const last = record.history.at(-1)
  const parts = [
    `${record.id} [${record.state} · owner ${clip(record.owner, 120)}]`,
    `${clip(record.outcome, 240)} → ${clip(record.target ?? 'target not recorded', 160)}`,
    `next: ${clip(record.next, 280)}`,
  ]

  if (record.wake) {
    parts.push(clip(record.wake, 240))
  }

  if (record.blocker) {
    parts.push(
      `blocked by: ${clip(record.blocker.blocker, 200)} ` +
        `(resumes when ${clip(record.blocker.resumeWhen, 160)})`,
    )
  }

  if (record.sources.length) {
    parts.push('sources: ' + record.sources.map((item) => sourceStatus(item, root)).join(', '))
  }

  if (record.attempts) {
    parts.push(`attempts ${record.attempts}` + (last ? ` (last: ${last.status})` : ''))
  }

  const evidence = record.evidence.at(-1)

  if (evidence) {
    parts.push(
      `evidence: ${clip(evidence.target, 80)}@${clip(evidence.revision, 80)}` +
        (evidence.closes ? '' : ' (not the authorized target)'),
    )
  }

  return parts.join(' · ')
}

/** Compact context for a turn, built from the records and nothing else. */
export function assignmentContext(ledger: AssignmentLedger, root?: string): string | undefined {
  const open = ledger.records.filter(isOpen)

  if (!open.length) {
    return undefined
  }

  invariant(open.length <= assignmentLimits.open, 'open assignments exceed their bound')
  return [
    'Assignments recorded for this session. Each stands on its own: a new request, a side ' +
      'question, an interrupt or work on another assignment never pauses or cancels it. One ' +
      'is paused or cancelled only on the user\'s own line "pause aN" or "cancel aN".',
    ...open.map((record) => describeAssignment(record, root)),
    'Update one with host_work and its assignment ID. Advance every active assignment you own; ' +
      'leave waiting ones to their sources. A finished worker, candidate or preview is not ' +
      'delivery: close with evidence for the authorized target and its revision. Honor newer ' +
      'user input.',
  ].join('\n')
}

/** The /assignments view: every retained record, open ones first. */
export function assignmentsView(ledger: AssignmentLedger, root?: string): string {
  if (!ledger.records.length) {
    return 'No assignments recorded in this session.'
  }

  const open = ledger.records.filter(isOpen)
  const closed = ledger.records.filter((record) => !isOpen(record))
  return [
    `Assignments · ${open.length} open of ${assignmentLimits.open} · ${closed.length} closed`,
    ...open.map((record) => describeAssignment(record, root)),
    ...closed
      .sort((left, right) => right.seq - left.seq)
      .slice(0, assignmentLimits.history)
      .map((record) => describeAssignment(record, root)),
  ].join('\n')
}

// One session belongs to one host process; writes from its hooks are serialized here.
const writers = new Map<string, Promise<unknown>>()

function validLedger(value: unknown, session: string): value is AssignmentLedger {
  const ledger = value as AssignmentLedger | undefined
  return Boolean(
    ledger &&
    ledger.version === 1 &&
    ledger.session === session &&
    Number.isInteger(ledger.nextId) &&
    Number.isInteger(ledger.seq) &&
    Array.isArray(ledger.records) &&
    ledger.records.length <= assignmentLimits.retained &&
    (ledger.confirmed === undefined || Array.isArray(ledger.confirmed)) &&
    ledger.records.every(
      (record) =>
        typeof record?.id === 'string' &&
        assignmentStates.includes(record.state) &&
        Array.isArray(record.sources) &&
        Array.isArray(record.history) &&
        Array.isArray(record.evidence) &&
        (record.confirmed === undefined || Array.isArray(record.confirmed)),
    ),
  )
}

/** The session's ledger file. A damaged file is an error, never an empty ledger. */
export class AssignmentStore {
  readonly path: string
  private cached: AssignmentLedger | undefined

  constructor(
    directory: string,
    readonly session: string,
  ) {
    const name = /^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : digest(session).slice(0, 32)
    this.path = join(directory, 'assignments', name + '.json')
  }

  /** Whether this session has ever recorded an assignment. */
  async exists(): Promise<boolean> {
    return this.cached !== undefined || (await readJson(this.path)) !== undefined
  }

  async read(): Promise<AssignmentLedger> {
    if (this.cached) {
      return this.cached
    }

    const stored = await readJson<unknown>(this.path)

    if (stored !== undefined && !validLedger(stored, this.session)) {
      throw new Error(`Assignment records are unreadable; inspect ${this.path}`)
    }

    this.cached = stored ?? emptyLedger(this.session)
    return this.cached
  }

  /** The records as last read or written, for callers that cannot wait. */
  get snapshot(): AssignmentLedger | undefined {
    return this.cached
  }

  /** Apply a change to a draft and persist it only if the change succeeds and alters it. */
  async mutate<T>(change: (ledger: AssignmentLedger) => T): Promise<T> {
    const previous = writers.get(this.path) ?? Promise.resolve()
    const run = previous
      .catch(() => {
        // An earlier writer's failure was reported to its own caller.
      })
      .then(async () => {
        const current = await this.read()
        const draft = structuredClone(current)
        const result = change(draft)

        if (JSON.stringify(draft) !== JSON.stringify(current)) {
          await atomicJson(this.path, draft)
          this.cached = draft
        }

        return result
      })
    writers.set(this.path, run)

    try {
      return await run
    } finally {
      if (writers.get(this.path) === run) {
        writers.delete(this.path)
      }
    }
  }
}
