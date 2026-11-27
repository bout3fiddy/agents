import assert from 'node:assert/strict'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { AssignmentStore } from '../src/assignments.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { hostWorkPaused, registerHostWork, type AssignmentDesk } from '../src/host-work.ts'
import { StateStore } from '../src/state.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import {
  ScriptedHost,
  arrived,
  call,
  controls,
  dispatched,
  fastDelivery,
  fastTick,
  privateAgentDirectory,
  quiet,
  records,
  registry,
  taskNamed,
  type Session,
  type Step,
} from './assignment-support.ts'
import { FixtureBoard, ManualClock } from './whiteboard-support.ts'

const blocker = {
  blocker: 'The operator holds the next input.',
  resumeWhen: 'the operator returns.',
}
const open = (name: string): Step => {
  return () => [
    call('host_work', {
      outcome: `Bring up ${name}`,
      target: `${name} cluster`,
      state: 'blocked',
      detail: `Start ${name} when the operator returns.`,
      retry: blocker,
    }),
  ]
}

// The escaped defect: the wakes that respect a paused host asked whether the most recently
// changed assignment was paused. Pausing one assignment therefore silenced the whole session,
// including requests for the assignments nobody paused. The real whiteboard listener runs here.
test('pausing one assignment leaves the automatic wakes of the others running', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  let desk: AssignmentDesk | undefined
  const model = new ScriptedHost((_self, texts) =>
    arrived(texts, 'Bring up ALPHA and BETA') ? [open('ALPHA'), open('BETA')] : undefined,
  )
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        desk = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        registerWhiteboard(pi, board.open, clock)
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await session.abort()
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const states = async () => (await records(root, session)).map((item) => [item.id, item.state])
  const polls = async (count: number) => {
    for (let poll = 0; poll < count; poll++) {
      await clock.tick()
      await session.waitForIdle()
    }
  }
  await session.prompt('/start_whiteboard')
  await session.prompt('Bring up ALPHA and BETA.')
  await quiet(session)
  await session.prompt('/assignments pause a2')
  assert.deepEqual(await states(), [
    ['a1', 'blocked'],
    ['a2', 'paused'],
  ])
  assert.equal(hostWorkPaused(desk!.current!), false, 'a1 was not paused, so the host is not')
  board.add('first', 'A note for ALPHA.')
  await polls(4)
  assert.equal(model.shown('Paired user requests', 'A note for ALPHA.'), 1, 'the wake arrived')

  // Retained: once the user has paused every open assignment, automatic wakes stay parked.
  await session.prompt('/assignments pause a1')
  assert.equal(hostWorkPaused(desk!.current!), true)
  board.add('second', 'A note while everything is paused.')
  await polls(6)
  assert.equal(model.shown('A note while everything is paused.'), 0, 'nothing woke the host')
  assert.deepEqual(await states(), [
    ['a1', 'paused'],
    ['a2', 'paused'],
  ])

  // Control: the note was parked by the pauses, not lost. With no open assignment it arrives.
  await session.prompt('/assignments cancel a1')
  await session.prompt('/assignments cancel a2')
  assert.equal(hostWorkPaused(desk!.current!), false)
  await polls(4)
  assert.equal(model.shown('A note while everything is paused.'), 1)
  assert.deepEqual(model.errors, [])
})

type Stop = 'pause' | 'cancel'

// The escaped defect: the confirmation rule consulted only the acting session's records. A
// second session of the same checkout could cancel, with its own explanation, the worker an
// open assignment of the first session waits on. The mistaken calls are injected as emitted.
test('a session cannot stop the task of an assignment another session recorded', async (t) => {
  const { root, base } = await fixture()
  privateAgentDirectory(t, join(await realpath(base), 'agent'))
  const second = join(base, 'second')
  await mkdir(second)
  const ids = { ALPHA: '', GAMMA: '' }
  const extensions = [
    (pi: Parameters<typeof registerHostWork>[0]) => {
      const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
      registerDelegation(pi, async () => {}, undefined, {
        assignments,
        tickMs: fastTick,
        delivery: fastDelivery,
      })
    },
  ]
  const owner = new ScriptedHost((_self, texts) =>
    arrived(texts, 'Start the work')
      ? [
          () =>
            (['ALPHA', 'GAMMA'] as const).map((name) =>
              call('delegate_task', {
                task: `${name}: update ${name.toLowerCase()}.md`,
                kind: 'documents',
                writePaths: [`${name.toLowerCase()}.md`],
                context: '',
              }),
            ),
          (context) => [
            call('host_work', {
              outcome: 'Ship ALPHA',
              target: 'main checkout',
              state: 'waiting',
              detail: 'Accept the ALPHA result and deliver it.',
              sources: [{ task: dispatched(context, 'ALPHA') }],
            }),
          ],
        ]
      : undefined,
  )
  const stop = (name: keyof typeof ids, action: Stop, message?: string): Step => {
    return () => [call('task_control', { id: ids[name], action, ...(message && { message }) })]
  }
  const other = new ScriptedHost((_self, texts) => {
    if (arrived(texts, 'Open EPSILON')) {
      return [open('EPSILON')]
    }

    if (arrived(texts, 'tidy up')) {
      return [
        stop('ALPHA', 'cancel', 'Stale work from an earlier session; the user asked to tidy up.'),
        stop('ALPHA', 'pause', 'Stopping it to reassign its files.'),
        stop('GAMMA', 'cancel'),
      ]
    }

    if (arrived(texts, 'pause ' + ids.ALPHA.slice(0, 8))) {
      return [stop('ALPHA', 'cancel'), stop('ALPHA', 'pause'), stop('ALPHA', 'pause')]
    }

    return arrived(texts, 'cancel ' + ids.ALPHA.slice(0, 8))
      ? [stop('ALPHA', 'cancel'), stop('ALPHA', 'cancel')]
      : undefined
  })
  const first = await captureSession(root, base, extensions, owner.respond)
  const acting = await captureSession(root, second, extensions, other.respond)
  const sessions: Session[] = [first.session, acting.session]
  t.after(async () => {
    for (const session of sessions) {
      await session.abort()
      session.dispose()
    }

    await first.runtime.settleCredentialWrites()
    await acting.runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await first.session.prompt('Start the work on ALPHA and GAMMA.')
  await quiet(first.session)
  ids.ALPHA = await taskNamed(registry(root), 'ALPHA')
  ids.GAMMA = await taskNamed(registry(root), 'GAMMA')
  const short = ids.ALPHA.slice(0, 8)
  const ledger = async (session: Session) =>
    new AssignmentStore(
      new StateStore(root).directory,
      session.sessionManager.getSessionId(),
    ).read()
  const state = async () =>
    JSON.stringify([
      await records(root, first.session),
      await ledger(acting.session),
      await controls(registry(root), ids.ALPHA),
    ])
  assert.deepEqual(
    (await records(root, first.session)).map((item) => [item.id, item.state, item.owner]),
    [['a1', 'waiting', `task ${ids.ALPHA}`]],
  )

  // The acting session has an a1 of its own. The user's "cancel a1" there names that record.
  await acting.session.prompt('Open EPSILON.')
  await quiet(acting.session)
  const before = await state()
  await acting.session.prompt('The earlier workers look stale; tidy up.\ncancel a1')
  await quiet(acting.session)
  assert.deepEqual(other.errors, [])
  assert.equal(await state(), before, 'no record and no control of the bound task changed')
  const refused = `Nothing changed: task ${ids.ALPHA} was not `
  assert.equal(
    other.shown(refused + 'cancelled', 'assignment a1 (Ship ALPHA)', `"cancel ${short}"`),
    1,
  )
  assert.equal(other.shown(refused + 'paused', 'assignment a1 (Ship ALPHA)', `"pause ${short}"`), 1)

  // A task no assignment tracks is controlled as before, from either session.
  assert.equal((await controls(registry(root), ids.GAMMA)).cancelled, true)

  // The user naming the task itself is the authority, for that action and once.
  await acting.session.prompt('pause ' + short)
  await quiet(acting.session)
  assert.equal(other.shown(refused + 'cancelled'), 2, 'a pause does not confirm a cancel')
  assert.equal(other.shown(refused + 'paused', 'already used'), 1)
  const paused = await controls(registry(root), ids.ALPHA)
  assert.deepEqual([paused.paused, paused.cancelled], [true, false])
  await acting.session.prompt('cancel ' + short)
  await quiet(acting.session)
  assert.equal(other.shown(refused + 'cancelled', 'already used'), 1)
  assert.equal((await controls(registry(root), ids.ALPHA)).cancelled, true)
  assert.deepEqual(other.errors, [])
  const used = (await ledger(acting.session)).confirmed ?? []
  assert.deepEqual(
    used.map((item) => [item.action, item.subject]),
    [
      ['pause', ids.ALPHA],
      ['cancel', ids.ALPHA],
    ],
    'each use is recorded in the session that acted',
  )
  assert.deepEqual(
    (await records(root, acting.session)).map((item) => [item.id, item.state]),
    [['a1', 'blocked']],
    'the acting session kept its own assignment',
  )
})
