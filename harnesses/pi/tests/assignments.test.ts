import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AssignmentStore,
  applyUpdate,
  assignmentContext,
  assignmentLimits,
  assignmentsView,
  blockUndelivered,
  confirmTaskCancel,
  confirmedStops,
  emptyLedger,
  importLegacy,
  isOpen,
  observeSources,
  resumeUndelivered,
  stallHost,
  taskKey,
  type AssignmentLedger,
  type AssignmentSource,
  type AssignmentUpdate,
  type Confirmation,
  type Observation,
  type StopAction,
} from '../src/assignments.ts'
import { DeliveryLedger, type DeliveryLimits } from '../src/delivery.ts'
import { generator, pick, simulationSeeds } from './simulation.ts'

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms)
const none = new Map<string, Observation>()
const task = (name: string): AssignmentSource => ({
  kind: 'task',
  key: taskKey(name),
  id: name,
  project: '/work/main',
})
const seen = (name: string, status: string, version = 0) =>
  new Map<string, Observation>([
    [taskKey(name), { status, terminal: status !== 'running', version }],
  ])
const open = (outcome: string, extra: Partial<AssignmentUpdate> = {}): AssignmentUpdate => ({
  outcome,
  target: 'origin/main',
  state: 'active',
  detail: 'Take the first step.',
  ...extra,
})

/** What the user confirmed in one message: by names it, targets are what it stops. */
const confirms = (by: string, action: StopAction, ...targets: string[]): Confirmation => ({
  by: 'message:' + by,
  stops: targets.map((target) => ({ action, target })),
})

/** Apply to a draft, as the store does: a rejected update changes nothing. */
function update(ledger: AssignmentLedger, change: AssignmentUpdate, observed = none, ms = 0) {
  const draft = structuredClone(ledger)
  const result = applyUpdate(draft, change, observed, at(ms))
  Object.assign(ledger, draft)
  return result
}

test('an assignment keeps the outcome and target it was authorized with', () => {
  const ledger = emptyLedger('s')
  const { record, created } = update(ledger, open('Ship the cache fix'))
  assert.equal(created, true)
  assert.deepEqual([record.id, record.state, record.owner], ['a1', 'active', 'host'])
  assert.throws(() => update(ledger, open('Ship the cache fix')), /a1 already tracks this outcome/)
  assert.throws(
    () => update(ledger, { assignment: 'a1', state: 'active', detail: 'x', target: 'staging' }),
    /The target is fixed when the work is authorized/,
  )
  assert.throws(
    () => update(ledger, { assignment: 'a1', state: 'active', detail: 'x', outcome: 'Other' }),
    /A different outcome is a new assignment/,
  )
  assert.throws(
    () => update(ledger, { state: 'active', detail: 'x', outcome: 'No target' }),
    /names its authorized delivery target/,
  )
  assert.throws(() => update(ledger, open('Closed at birth', { state: 'done' })), /Open an assign/)
  assert.throws(
    () => update(ledger, { assignment: 'a9', state: 'active', detail: 'x' }),
    /No assignment a9 in this session\. Known: a1/,
  )
  assert.equal(ledger.records.length, 1)
})

test('only evidence for the authorized target and its revision closes an assignment', () => {
  const ledger = emptyLedger('s')
  update(ledger, open('Ship the cache fix', { state: 'waiting', sources: [task('t1')] }))
  const done = { assignment: 'a1', state: 'done' as const, detail: 'Merged.' }
  assert.throws(
    () => update(ledger, { ...done, evidence: { target: 'origin/main', revision: 'abc' } }),
    /still has running sources: task t1/,
  )
  observeSources(ledger, seen('t1', 'complete'), at(1))
  assert.equal(ledger.records[0]!.state, 'active', 'a finished worker hands back, never closes')
  assert.throws(() => update(ledger, done), /requires evidence with the delivered revision/)
  assert.throws(
    () => update(ledger, { ...done, evidence: { target: 'preview', revision: 'abc' } }),
    /A candidate, preview or other target does not close it/,
  )
  assert.deepEqual(ledger.records[0]!.evidence, [], 'a rejected close records nothing')

  // The same evidence is welcome as progress; it is marked as not the authorized target.
  const progress = update(ledger, {
    assignment: 'a1',
    state: 'active',
    detail: 'Preview verified; merging next.',
    evidence: { target: 'preview', revision: 'abc' },
  })
  assert.equal(progress.record.evidence[0]!.closes, false)
  const closed = update(ledger, {
    ...done,
    evidence: { target: ' Origin/Main ', revision: 'abc', summary: 'Merged and green.' },
  })
  assert.equal(closed.record.state, 'done')
  assert.equal(closed.record.evidence.at(-1)!.closes, true)
  assert.throws(
    () => update(ledger, { assignment: 'a1', state: 'active', detail: 'x' }),
    /a1 is closed \(done\)/,
  )
})

test('waiting needs a registered source that is still running', () => {
  const ledger = emptyLedger('s')
  assert.throws(
    () => update(ledger, open('Ship it', { state: 'waiting' })),
    /Waiting needs a registered wake source/,
  )
  assert.equal(ledger.records.length, 0)

  // The source finished before it was bound: the assignment stays with the host.
  const early = update(
    ledger,
    open('Ship it', { state: 'waiting', sources: [task('t1')] }),
    seen('t1', 'complete'),
  )
  assert.equal(early.record.state, 'active')
  assert.match(early.notes[0]!, /Every bound source already finished \(task t1 complete\)/)
  assert.equal(early.record.attempts, 1)

  // The task was started again: it is a running source once more.
  const again = update(
    ledger,
    { assignment: 'a1', state: 'waiting', detail: 'Accept the second run.' },
    seen('t1', 'running', 1),
  )
  assert.deepEqual([again.record.state, again.record.owner], ['waiting', 'task t1'])
  assert.deepEqual(observeSources(ledger, seen('t1', 'failed', 1), at(5)), ['a1'])
  assert.deepEqual(
    [ledger.records[0]!.state, ledger.records[0]!.attempts, ledger.records[0]!.wake],
    ['active', 2, 'Sources finished: task t1 failed'],
  )
  assert.throws(
    () => update(ledger, { assignment: 'a1', state: 'blocked', detail: 'x' }),
    /names its blocker and owner/,
  )
})

test('observing a source twice changes nothing the second time', () => {
  const ledger = emptyLedger('s')
  update(ledger, open('Ship it', { state: 'waiting', sources: [task('t1'), task('t2')] }))
  assert.deepEqual(observeSources(ledger, seen('t1', 'complete'), at(1)), ['a1'])
  assert.equal(ledger.records[0]!.state, 'waiting', 'one of two sources is not all of them')
  const once = JSON.stringify(ledger)
  assert.deepEqual(observeSources(ledger, seen('t1', 'complete'), at(2)), [])
  assert.equal(JSON.stringify(ledger), once)
  assert.deepEqual(observeSources(ledger, seen('t2', 'failed'), at(3)), ['a1'])
  assert.deepEqual([ledger.records[0]!.state, ledger.records[0]!.attempts], ['active', 2])
})

test('one source advances one assignment and the ledger stays bounded', () => {
  const ledger = emptyLedger('s')
  update(ledger, open('First', { state: 'waiting', sources: [task('t1')] }))
  assert.throws(
    () => update(ledger, open('Second', { state: 'waiting', sources: [task('t1')] })),
    /task t1 is already bound to assignment a1/,
  )

  for (let index = 2; index <= assignmentLimits.open; index++) {
    update(ledger, open('Outcome ' + index))
  }

  assert.throws(() => update(ledger, open('One too many')), /already holds 12 open assignments/)

  // Closed records are dropped oldest first; an open one is never dropped.
  for (let round = 0; round < 60; round++) {
    const id = 'a' + ledger.records.at(-1)!.id.slice(1)
    update(ledger, {
      assignment: id,
      state: 'cancelled',
      detail: 'Withdrawn.',
      confirmation: confirms('round' + round, 'cancel', id),
    })
    update(ledger, open('Round ' + round))
  }

  assert.equal(ledger.records.length, assignmentLimits.retained)
  assert.equal(ledger.records.filter(isOpen).length, assignmentLimits.open)
  assert.equal(ledger.records[0]!.id, 'a1')

  // A ninth source replaces a settled one and is refused while all eight still run.
  const names = Array.from({ length: assignmentLimits.sources }, (_, index) => 'w' + index)
  const waiting = { assignment: 'a2', state: 'waiting' as const, detail: 'Wait.' }
  update(ledger, { ...waiting, sources: names.map(task) })
  assert.throws(
    () => update(ledger, { ...waiting, sources: [task('w9')] }),
    /already waits on 8 running sources/,
  )
  observeSources(ledger, seen('w0', 'failed'), at(9))
  const replaced = update(ledger, { ...waiting, sources: [task('w9')] })
  assert.equal(replaced.record.sources.length, assignmentLimits.sources)
  assert.equal(replaced.record.attempts, 1, 'the evicted source stays counted')
})

test('a stall and a lost wake stop the host and nothing else', () => {
  const ledger = emptyLedger('s')
  update(ledger, open('Host step'))
  update(ledger, open('Worker step', { state: 'waiting', sources: [task('t1')] }))
  update(ledger, open('Other host step'))
  const waiting = JSON.stringify(ledger.records[1])
  const ready = JSON.stringify(ledger.records[2])

  // A stall names the assignments the host run answered for. A waiting one is never stalled,
  // and another active one the run was not asked about stays ready.
  assert.deepEqual(stallHost(ledger, ['a1', 'a2'], at(2)), ['a1'])
  assert.equal(ledger.records[0]!.blocker?.kind, 'stalled')
  assert.equal(JSON.stringify(ledger.records[2]), ready, 'an unnamed active record is unchanged')
  assert.deepEqual(stallHost(ledger, [], at(2)), [], 'a stall that names nothing changes nothing')
  update(ledger, { assignment: 'a1', state: 'active', detail: 'Resumed again.' })
  assert.deepEqual(blockUndelivered(ledger, ['a1', 'a2'], at(3)), ['a1'])
  assert.equal(ledger.records[0]!.blocker?.kind, 'delivery')
  assert.deepEqual(resumeUndelivered(ledger, at(4)), ['a1'])
  assert.deepEqual([ledger.records[0]!.state, ledger.records[0]!.blocker], ['active', undefined])
  assert.equal(JSON.stringify(ledger.records[1]), waiting)

  const cancelled = update(ledger, {
    assignment: 'a2',
    state: 'cancelled',
    detail: 'Withdrawn.',
    confirmation: confirms('m1', 'cancel', 'a2'),
  })
  assert.deepEqual(
    cancelled.release.map((source) => source.key),
    [taskKey('t1')],
    'cancelling names exactly its own running sources',
  )
})

test('only a whole line naming the work is a confirmation', () => {
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd'
  const read = (text: string) => confirmedStops(text).map((stop) => stop.action + ' ' + stop.target)
  assert.deepEqual(read('cancel a2'), ['cancel a2'])
  assert.deepEqual(read('  Please PAUSE assignment A1.  '), ['pause a1'])
  assert.deepEqual(read('cancel a1, a3 and a12'), ['cancel a1', 'cancel a3', 'cancel a12'])
  assert.deepEqual(read(`cancel task ${id}`), ['cancel ' + id])
  assert.deepEqual(read('cancel 1a2b3c4d!'), ['cancel 1a2b3c4d'])
  assert.deepEqual(
    read('ALPHA is obsolete.\ncancel a1\nKeep the rest going.\npause a3'),
    ['cancel a1', 'pause a3'],
    'each confirming line counts and the prose around it does not',
  )

  // Sentences that mention stopping are not instructions the runtime may act on.
  for (const prose of [
    'Should I cancel a2?',
    "Don't cancel a2",
    'do not pause a1',
    'cancel a2 unless it already shipped',
    'I might cancel a2 later',
    'Cancel ALPHA only.',
    'cancel everything',
    'pause all',
    'cancel a0',
    'cancel a2 and the rest',
    'stop a2',
    'resume a2',
    'cancel',
    'cancel 1a2b3c4',
    'cancel a1; cancel a2',
    'cancel' + ' '.repeat(assignmentLimits.confirmationLineLength) + 'a2',
  ]) {
    assert.deepEqual(read(prose), [], prose)
  }

  // Bounded: a long message is read up to its line limit, a long list up to its stop limit.
  const padding = 'note\n'.repeat(assignmentLimits.confirmationLines)
  assert.deepEqual(read(padding + 'cancel a1'), [])
  assert.deepEqual(read('note\n'.repeat(assignmentLimits.confirmationLines - 1) + 'cancel a1'), [
    'cancel a1',
  ])
  const many = Array.from({ length: assignmentLimits.stops + 4 }, (_, index) => 'a' + (index + 1))
  assert.equal(read('cancel ' + many.join(' ')).length, assignmentLimits.stops)
})

test('an assignment is paused or cancelled only on a confirmation naming it, once', () => {
  const ledger = emptyLedger('s')
  update(ledger, open('First'))
  update(ledger, open('Second'))
  const whole = JSON.stringify(ledger)
  const stop = (assignment: string, state: 'paused' | 'cancelled') => ({
    assignment,
    state,
    detail: 'Stopped.',
  })

  // No confirmation, one for the other assignment and one for the other action all refuse.
  for (const state of ['paused', 'cancelled'] as const) {
    const action = state === 'paused' ? 'cancel' : 'pause'
    assert.throws(() => update(ledger, stop('a2', state)), /Nothing changed: assignment a2/)
    assert.throws(
      () => update(ledger, { ...stop('a2', state), confirmation: confirms('m1', 'pause', 'a1') }),
      /latest message does not confirm this/,
    )
    assert.throws(
      () => update(ledger, { ...stop('a2', state), confirmation: confirms('m1', action, 'a2') }),
      /Nothing changed/,
    )
    assert.throws(
      () => update(ledger, { ...stop('a2', state), confirmation: confirms('m1', 'pause') }),
      new RegExp(`reply with the line "${state === 'paused' ? 'pause' : 'cancel'} a2"`),
    )
  }

  assert.equal(JSON.stringify(ledger), whole, 'a refused stop changed nothing')

  // The confirmation pauses the assignment it names and no other.
  const first = JSON.stringify(ledger.records[0])
  const paused = update(ledger, {
    ...stop('a2', 'paused'),
    confirmation: confirms('m1', 'pause', 'a2'),
  })
  assert.deepEqual([paused.record.state, paused.record.owner], ['paused', 'user'])
  assert.equal(JSON.stringify(ledger.records[0]), first)

  // Restating a pause needs nothing new; resuming and pausing again does.
  update(ledger, { ...stop('a2', 'paused'), detail: 'Still paused.' })
  update(ledger, { assignment: 'a2', state: 'active', detail: 'Resumed on request.' })
  const resumed = JSON.stringify(ledger)
  assert.throws(
    () => update(ledger, { ...stop('a2', 'paused'), confirmation: confirms('m1', 'pause', 'a2') }),
    /already used to pause it once/,
  )
  assert.equal(JSON.stringify(ledger), resumed)
  update(ledger, { ...stop('a2', 'paused'), confirmation: confirms('m2', 'pause', 'a2') })
  assert.deepEqual(
    ledger.records[1]!.confirmed?.map((item) => [item.action, item.subject, item.by]),
    [
      ['pause', 'a2', 'message:m1'],
      ['pause', 'a2', 'message:m2'],
    ],
  )

  // A later rejection in the same update leaves the confirmation unused.
  assert.throws(
    () =>
      update(ledger, {
        ...stop('a1', 'cancelled'),
        retry: { blocker: 'x', resumeWhen: 'y' },
        confirmation: confirms('m3', 'cancel', 'a1'),
      }),
    /Report retry conditions only/,
  )
  assert.equal(ledger.records[0]!.confirmed, undefined)
  update(ledger, { ...stop('a1', 'cancelled'), confirmation: confirms('m3', 'cancel', 'a1') })
  assert.equal(ledger.records[0]!.state, 'cancelled')
  assert.ok(ledger.records[1]!.confirmed!.length <= assignmentLimits.confirmed)
})

test('cancelling a bound task needs a confirmation for it or its assignment, once', () => {
  const ledger = emptyLedger('s')
  const first = '1a2b3c4d-0000-4000-8000-00000000abcd'
  const second = '5e6f7a8b-0000-4000-8000-00000000abcd'
  update(ledger, open('First', { state: 'waiting', sources: [task(first)] }))
  update(ledger, open('Second', { state: 'waiting', sources: [task(second)] }))
  const whole = JSON.stringify(ledger)
  const cancel = (id: string, confirmation?: Confirmation) => {
    const draft = structuredClone(ledger)
    const record = confirmTaskCancel(draft, id, confirmation, at(5))
    Object.assign(ledger, draft)
    return record?.id
  }
  assert.throws(() => cancel(first), /Nothing changed: task 1a2b3c4d-.* of assignment a1/)
  assert.throws(() => cancel(first, confirms('m1', 'cancel', 'a2', second)), /Nothing changed/)
  assert.throws(() => cancel(first, confirms('m1', 'pause', 'a1')), /Nothing changed/)
  assert.throws(
    () => cancel(first, confirms('m1', 'cancel', second.slice(0, 8))),
    /"cancel 1a2b3c4d" for this task alone/,
  )
  assert.equal(JSON.stringify(ledger), whole, 'a refused cancellation changed nothing')

  // The task's own ID, its first eight characters or its assignment each confirm it.
  assert.equal(cancel(first, confirms('m1', 'cancel', first.slice(0, 8))), 'a1')
  assert.throws(() => cancel(first, confirms('m1', 'cancel', first.slice(0, 8))), /already used/)
  assert.equal(cancel(first, confirms('m2', 'cancel', first)), 'a1')
  assert.equal(cancel(second, confirms('m2', 'cancel', 'a2')), 'a2')
  assert.deepEqual(
    ledger.records.map((record) => [record.state, record.seq, record.confirmed?.length]),
    [
      ['waiting', 1, 2],
      ['waiting', 2, 1],
    ],
    'the use is recorded and the assignment itself is not changed or handed back',
  )

  // A task no open assignment tracks is not this ledger's to refuse.
  assert.equal(cancel('9c9c9c9c-0000-4000-8000-00000000abcd'), undefined)
  update(ledger, {
    assignment: 'a2',
    state: 'cancelled',
    detail: 'Withdrawn.',
    confirmation: confirms('m3', 'cancel', 'a2'),
  })
  assert.equal(cancel(second), undefined, 'a closed assignment no longer binds its task')
})

test('host work recorded by the earlier scheme is carried forward, never dropped', () => {
  const ledger = emptyLedger('s')
  assert.equal(importLegacy(ledger, { state: 'done', detail: 'Old.' }, [], at(0)), undefined)
  const active = importLegacy(ledger, { state: 'active', detail: 'Deploy v2.' }, [], at(1))
  const unbound = importLegacy(ledger, { state: 'waiting', detail: 'Await key.' }, [], at(2))
  const bound = importLegacy(ledger, { state: 'waiting', detail: 'Await t1.' }, [task('t1')], at(3))
  assert.deepEqual(
    [active, unbound, bound].map((item) => [item?.state, item?.legacy, item?.blocker?.kind]),
    [
      ['active', true, undefined],
      ['blocked', true, 'legacy'],
      ['waiting', true, undefined],
    ],
  )

  // A carried record had no target, so its close needs no target match.
  const closed = update(ledger, { assignment: 'a1', state: 'done', detail: 'Deployed.' })
  assert.equal(closed.record.state, 'done')
})

test('the turn context and the /assignments view are built from the records', () => {
  const ledger = emptyLedger('s')
  assert.equal(assignmentContext(ledger), undefined)
  assert.equal(assignmentsView(ledger), 'No assignments recorded in this session.')
  update(ledger, open('Ship the cache fix', { state: 'waiting', sources: [task('t1')] }))
  update(
    ledger,
    open('Rotate the key', {
      state: 'blocked',
      retry: { blocker: 'Security must approve.', resumeWhen: 'the ticket is approved.' },
    }),
  )
  update(ledger, open('Old work'))
  update(ledger, {
    assignment: 'a3',
    state: 'done',
    detail: 'Merged.',
    evidence: { target: 'origin/main', revision: 'abc123' },
  })
  observeSources(ledger, seen('t1', 'failed'), at(5))
  const context = assignmentContext(ledger, '/work/main')!
  assert.match(context, /^a1 \[active · owner host\] · Ship the cache fix → origin\/main/m)
  assert.match(context, /Sources finished: task t1 failed · sources: task t1 failed · attempts 1/)
  assert.match(context, /^a2 \[blocked · owner external\].*blocked by: Security must approve\./m)
  assert.doesNotMatch(context, /Old work/, 'closed work leaves the turn context')
  assert.ok(context.length < 4000)
  const view = assignmentsView(ledger, '/work/elsewhere')
  assert.match(view, /^Assignments · 2 open of 12 · 1 closed$/m)
  assert.match(view, /task t1 in \/work\/main failed/, 'another checkout is named')
  assert.match(view, /^a3 \[done · owner closed\].*evidence: origin\/main@abc123$/m)
})

test('the store persists per session and refuses a damaged file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-assignments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AssignmentStore(directory, 'session-one')
  assert.equal(await store.exists(), false)
  await Promise.all(
    ['A', 'B', 'C'].map((name) =>
      store.mutate((ledger) => applyUpdate(ledger, open(name), none, at(0))),
    ),
  )
  await assert.rejects(
    store.mutate((ledger) => applyUpdate(ledger, open('A'), none, at(1))),
    /already tracks this outcome/,
  )
  const reread = await new AssignmentStore(directory, 'session-one').read()
  assert.deepEqual(
    reread.records.map((record) => record.id),
    ['a1', 'a2', 'a3'],
  )
  assert.deepEqual((await new AssignmentStore(directory, 'session-two').read()).records, [])
  await writeFile(store.path, JSON.stringify({ version: 1, session: 'session-two', records: [] }))
  await assert.rejects(
    new AssignmentStore(directory, 'session-one').read(),
    /Assignment records are unreadable/,
  )
})

const limits: DeliveryLimits = { attempts: 4, retryMs: 10, maxRetryMs: 80, capacity: 256 }

test('a wake is repeated with growing delays, a bounded number of times', () => {
  const offers = new DeliveryLedger(limits)
  const sent: number[] = []

  for (let now = 0; now <= 2000; now++) {
    if (offers.dueWhileIdle('k', now)) {
      offers.offer('k', now)
      sent.push(now)
    }
  }

  assert.deepEqual(sent, [0, 10, 30, 70], 'four offers, each delay double the last')
  assert.deepEqual(offers.exhausted(149), [])
  assert.deepEqual(offers.exhausted(150), ['k'])
  assert.deepEqual(offers.exhausted(9999), [], 'the blocker is reported once')

  // A running turn can still append it: bounded by time, not by the spent idle attempts.
  assert.equal(offers.dueAtBoundary('k', 150), true)
  offers.offer('k', 150, true)
  assert.equal(offers.dueAtBoundary('k', 159), false)
  assert.equal(offers.dueAtBoundary('k', 160), true)
  assert.equal(offers.acknowledge('k'), true)
  assert.equal(offers.acknowledge('k'), false)
  assert.equal(offers.size, 0)

  // An offer that was prepared and never sent does not count against the bound.
  offers.offer('r', 0)
  offers.retract('r')
  assert.equal(offers.attempts('r'), 0)
  assert.equal(offers.dueWhileIdle('r', 0), true)

  for (let index = 0; index < limits.capacity + 10; index++) {
    offers.offer('fill' + index, 0)
  }

  assert.equal(offers.size, limits.capacity, 'the ledger forgets its oldest offers')
})

type World = {
  ledger: AssignmentLedger
  tasks: Map<string, { status: 'running' | 'complete' | 'failed'; version: number }>
  expectedAttempts: Map<string, number>
  offers: DeliveryLedger
  receipts: Set<string>
  sent: Map<string, number[]>
  reported: string[]
  now: number
}

function observations(world: World) {
  return new Map<string, Observation>(
    [...world.tasks].map(([name, state]) => [
      taskKey(name),
      { status: state.status, terminal: state.status !== 'running', version: state.version },
    ]),
  )
}

/** One reconciliation and delivery pass, as the desk and the feed perform it while idle. */
function pass(world: World, dropped: () => boolean) {
  const before = new Map(world.ledger.records.map((record) => [record.id, JSON.stringify(record)]))
  const changed = observeSources(world.ledger, observations(world), at(world.now))
  assert.deepEqual(observeSources(world.ledger, observations(world), at(world.now)), [])

  for (const record of world.ledger.records) {
    if (!changed.includes(record.id)) {
      assert.equal(JSON.stringify(record), before.get(record.id), 'an unrelated record changed')
    }

    for (const source of record.sources) {
      const state = world.tasks.get(source.kind === 'task' ? source.id : '')

      if (isOpen(record) && state?.status !== 'running' && changed.includes(record.id)) {
        const settled = `${record.id}:${source.key}:${state?.version}`

        if (!world.sent.has('attempt:' + settled)) {
          world.sent.set('attempt:' + settled, [])
          world.expectedAttempts.set(record.id, (world.expectedAttempts.get(record.id) ?? 0) + 1)
        }
      }
    }
  }

  for (const [name, state] of world.tasks) {
    const key = `${name}:${state.version}`

    if (state.status === 'running' || world.receipts.has(key)) {
      continue
    }

    if (world.offers.dueWhileIdle(key, world.now)) {
      world.offers.offer(key, world.now)
      world.sent.set(key, [...(world.sent.get(key) ?? []), world.now])

      if (!dropped()) {
        world.receipts.add(key)
        world.offers.acknowledge(key)
      }
    }
  }

  world.reported.push(...world.offers.exhausted(world.now))
}

function invariants(world: World) {
  const { ledger } = world
  assert.ok(ledger.records.filter(isOpen).length <= assignmentLimits.open)
  assert.ok(ledger.records.length <= assignmentLimits.retained)

  for (const record of ledger.records) {
    assert.ok(record.sources.length <= assignmentLimits.sources)
    assert.ok(record.history.length <= assignmentLimits.history)
    assert.equal(record.attempts, world.expectedAttempts.get(record.id) ?? 0, record.id)

    if (record.state === 'done') {
      assert.equal(record.evidence.at(-1)?.closes, true, 'closed without matching evidence')
      assert.ok(
        record.sources.every((source) => source.settled),
        'closed over a running source',
      )
    }
  }

  for (const [key, times] of world.sent) {
    if (key.startsWith('attempt:')) {
      continue
    }

    assert.ok(times.length <= limits.attempts, 'more wakes than the bound')

    for (let index = 1; index < times.length; index++) {
      const least = Math.min(limits.retryMs * 2 ** (index - 1), limits.maxRetryMs)
      assert.ok(times[index]! - times[index - 1]! >= least, 'a wake repeated too soon')
    }
  }
}

// Seeded schedules over the record model and the delivery ledger with a simulated clock and a
// lossy wake channel. Replay one with PI_SIMULATION_SEED=<seed>.
for (const seed of simulationSeeds(200)) {
  test(`assignment schedule ${seed} keeps its invariants and settles`, () => {
    const next = generator(seed)
    const world: World = {
      ledger: emptyLedger('s'),
      tasks: new Map(),
      expectedAttempts: new Map(),
      offers: new DeliveryLedger(limits),
      receipts: new Set(),
      sent: new Map(),
      reported: [],
      now: 0,
    }
    const lossy = () => next() < 0.4
    const others = (id: string) =>
      JSON.stringify(world.ledger.records.filter((record) => record.id !== id))
    const operations = [
      'open',
      'finish',
      'resume',
      'close',
      'cancel',
      'side',
      'mistake',
      'pass',
      'pass',
    ]

    for (let step = 0; step < 160; step++) {
      const openRecords = world.ledger.records.filter(isOpen)
      const operation = pick(next, operations)
      world.now += 1 + Math.floor(next() * 25)

      if (operation === 'open' && openRecords.length < assignmentLimits.open) {
        const name = 't' + world.tasks.size
        world.tasks.set(name, { status: 'running', version: 0 })
        update(
          world.ledger,
          open('Outcome ' + name, { state: 'waiting', sources: [task(name)] }),
          observations(world),
          world.now,
        )
      } else if (operation === 'finish') {
        const running = [...world.tasks.values()].filter((state) => state.status === 'running')

        if (running.length) {
          pick(next, running).status = next() < 0.5 ? 'complete' : 'failed'
        }
      } else if (operation === 'resume') {

        // The host starts a failed attempt again once the records show it handed back.
        const retry = openRecords.find(
          (record) =>
            record.state === 'active' &&
            record.sources.some((source) => source.settled?.status === 'failed'),
        )

        if (retry) {
          const failed = retry.sources.find((source) => source.settled?.status === 'failed')!
          const state = world.tasks.get(failed.kind === 'task' ? failed.id : '')!
          const before = others(retry.id)
          state.status = 'running'
          state.version++
          update(
            world.ledger,
            { assignment: retry.id, state: 'waiting', detail: 'Accept the retry.' },
            observations(world),
            world.now,
          )
          assert.equal(others(retry.id), before)
        }
      } else if (operation === 'mistake') {
        if (!openRecords.length) {
          continue
        }

        // The host stops work the user did not name: with no confirmation, or with one that
        // names another assignment. Neither changes anything.
        const record = pick(next, openRecords)
        const other = pick(next, openRecords)
        const state = next() < 0.5 ? ('paused' as const) : ('cancelled' as const)
        const action = state === 'paused' ? 'pause' : 'cancel'
        const whole = JSON.stringify(world.ledger)
        const mistaken = { assignment: record.id, state, detail: 'Superseded.' }

        if (record.state !== state) {
          assert.throws(() => update(world.ledger, mistaken), /Nothing changed/)
        }

        if (other !== record && record.state !== state) {
          assert.throws(
            () =>
              update(world.ledger, {
                ...mistaken,
                confirmation: confirms('step' + step, action, other.id),
              }),
            /Nothing changed/,
          )
        }

        const bound = record.sources.find((source) => source.kind === 'task')

        if (bound?.kind === 'task') {
          const draft = structuredClone(world.ledger)
          assert.throws(() => confirmTaskCancel(draft, bound.id, undefined, at(world.now)))
        }

        assert.equal(JSON.stringify(world.ledger), whole, 'a mistaken stop changed the ledger')
      } else if (operation === 'close' || operation === 'cancel' || operation === 'side') {
        if (!openRecords.length) {
          continue
        }

        const record = pick(next, openRecords)
        const before = others(record.id)
        const whole = JSON.stringify(world.ledger)

        if (operation === 'side') {
          update(world.ledger, {
            assignment: record.id,
            state: record.state === 'waiting' ? 'waiting' : 'active',
            detail: 'Side note ' + step,
          })
        } else if (operation === 'cancel') {
          const { release } = update(world.ledger, {
            assignment: record.id,
            state: 'cancelled',
            detail: 'Withdrawn.',
            confirmation: confirms('step' + step, 'cancel', record.id),
          })
          assert.deepEqual(
            release.map((source) => source.key).sort(),
            record.sources
              .filter((source) => !source.settled)
              .map((source) => source.key)
              .sort(),
          )
        } else {
          const done = { assignment: record.id, state: 'done' as const, detail: 'Delivered.' }
          assert.throws(() =>
            update(world.ledger, { ...done, evidence: { target: 'preview', revision: 'r' } }),
          )
          assert.equal(JSON.stringify(world.ledger), whole, 'a refused close changed the ledger')

          if (record.sources.every((source) => source.settled)) {
            update(world.ledger, { ...done, evidence: { target: 'origin/main', revision: 'r' } })
          }
        }

        assert.equal(others(record.id), before, operation + ' changed another assignment')
      } else {
        pass(world, lossy)
      }

      invariants(world)
    }

    // The channel recovers. Within the longest backoff every finished outcome is acknowledged,
    // or its spent wake was reported exactly once; no assignment still waits on a finished task.
    for (let tick = 0; tick < 40; tick++) {
      world.now += limits.maxRetryMs
      pass(world, () => false)
      invariants(world)
    }

    assert.equal(new Set(world.reported).size, world.reported.length, 'a blocker reported twice')

    for (const [name, state] of world.tasks) {
      const key = `${name}:${state.version}`

      if (state.status !== 'running') {
        assert.ok(world.receipts.has(key) || world.reported.includes(key), key + ' was lost')
      }
    }

    for (const record of world.ledger.records) {
      if (record.state === 'waiting') {
        assert.ok(
          record.sources.some((source) => !source.settled),
          record.id + ' waits on nothing',
        )
      }
    }
  })
}

test('control: a ledger that offers once leaves a dropped wake unacknowledged', () => {
  const world: World = {
    ledger: emptyLedger('s'),
    tasks: new Map([['t0', { status: 'complete', version: 0 }]]),
    expectedAttempts: new Map(),
    offers: new DeliveryLedger({ ...limits, attempts: 1 }),
    receipts: new Set(),
    sent: new Map(),
    reported: [],
    now: 0,
  }
  let first = true
  const dropFirst = () => {
    const dropped = first
    first = false
    return dropped
  }

  for (let tick = 0; tick < 40; tick++) {
    world.now += limits.maxRetryMs
    pass(world, dropFirst)
  }

  assert.equal(world.receipts.has('t0:0'), false, 'the settle check would report this as lost')
  assert.deepEqual(world.reported, ['t0:0'], 'and the ledger says so once')
})
