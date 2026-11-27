import assert from 'node:assert/strict'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Type } from 'typebox'
import type { Context } from '@earendil-works/pi-ai'
import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent'
import type { TaskControls } from '../src/delegation-state.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { textResult } from '../src/file-tools.ts'
import { hostWorkPaused, registerHostWork, type AssignmentDesk } from '../src/host-work.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import {
  ScriptedHost,
  arrived,
  call,
  continued,
  controls,
  dispatched,
  fastDelivery,
  fastTick,
  privateAgentDirectory,
  quiet,
  record,
  records,
  registry,
  taskNamed,
  type Session,
  type Step,
} from './assignment-support.ts'

const blocker = {
  blocker: 'The operator holds the next input.',
  resumeWhen: 'the operator returns.',
}

/**
 * Capture a state before every model request. The request that follows a tool call sees what
 * that call left behind, so a refused call is shown to have changed nothing.
 */
function observed(model: ScriptedHost, capture: () => Promise<string>) {
  const states: string[] = []
  return {
    states,
    async respond(context: Context) {
      states.push(await capture())
      return model.respond(context)
    },

    /** Whether the state was the same before and after the request answered with phrase. */
    unchangedBy(phrase: string) {
      const refused = model.requests.flatMap((texts, index) =>
        texts.some((text) => text.includes(phrase)) ? [index] : [],
      )
      assert.ok(refused.length > 0, 'a call was refused with: ' + phrase)
      return refused.every((index) => states[index] === states[index - 1])
    },
  }
}

// The escaped defect: an interrupt selected every active assignment and relabelled each one
// paused/user. Stopping the current turn is not authority over the records. The real settlement
// hooks run here with two active assignments and one blocked one.
test('an interrupt stops the turn and pauses no assignment', async (t) => {
  const { root, base } = await fixture()
  let entered!: () => void
  const holding = new Promise<void>((resolve) => {
    entered = resolve
  })
  let desk: AssignmentDesk | undefined
  let session!: Session
  const open = (name: string, extra: Record<string, unknown> = {}): Step => {
    return () => [
      call('host_work', {
        outcome: `Bring up ${name}`,
        target: `${name} cluster`,
        state: 'active',
        detail: `Start ${name} and probe it.`,
        ...extra,
      }),
    ]
  }
  const park = (id: string): Step => {
    return () => [
      call('host_work', {
        assignment: id,
        state: 'blocked',
        detail: 'Continue when the operator returns.',
        retry: blocker,
      }),
    ]
  }
  const model = new ScriptedHost((_self, texts) => {
    const handedBack = arrived(texts, 'The host owns the next step')

    if (handedBack) {
      return continued(handedBack).map((item) => park(item.assignment))
    }

    // Checked first: the interrupted reply is not in context, so the opening request still is.
    if (arrived(texts, 'pause a1')) {
      return [

        // The wrong call: the user named a1, the host stops a2 and explains it itself.
        () => [
          call('host_work', {
            assignment: 'a2',
            state: 'paused',
            detail: 'The user interrupted, so everything stops.',
          }),
        ],
        () => [call('host_work', { assignment: 'a1', state: 'paused', detail: 'Resume ALPHA.' })],

        // The confirmation is good for one pause: the host resumes and tries to reuse it.
        () => [call('host_work', { assignment: 'a1', state: 'active', detail: 'Resume ALPHA.' })],
        () => [call('host_work', { assignment: 'a1', state: 'paused', detail: 'Stop again.' })],
      ]
    }

    if (arrived(texts, 'Bring up ALPHA, BETA')) {
      return [
        open('ALPHA'),
        open('BETA'),
        open('GAMMA', { state: 'blocked', retry: blocker }),
        () => [call('await_service', {})],
      ]
    }

    return undefined
  })
  const watch = observed(model, async () => JSON.stringify(await records(root, session)))
  const created = await captureSession(
    root,
    base,
    [
      (pi) => {
        desk = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        pi.registerTool({
          name: 'await_service',
          label: 'Await service',
          description: 'Hold until interrupted',
          parameters: Type.Object({}),
          async execute(_id, _input, signal) {
            entered()

            if (!signal?.aborted) {
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true }),
              )
            }

            return textResult('Interrupted.')
          },
        })
      },
    ],
    (context) => watch.respond(context),
  )
  session = created.session
  t.after(async () => {
    await session.abort()
    session.dispose()
    await created.runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const request = session.prompt('Bring up ALPHA, BETA and GAMMA.')
  await holding
  const before = await records(root, session)
  assert.deepEqual(
    before.map((item) => [item.id, item.state, item.owner]),
    [
      ['a1', 'active', 'host'],
      ['a2', 'active', 'host'],
      ['a3', 'blocked', 'external'],
    ],
  )
  await session.abort()
  await request
  await session.waitForIdle()
  const requests = model.requests.length

  // Longer than the hand-back grace period and its first repeats: a wake would have come.
  await delay(20 * fastTick + 4 * fastDelivery.retryMs)
  await session.waitForIdle()
  assert.deepEqual(await records(root, session), before, 'the interrupt changed no record')
  assert.equal(model.requests.length, requests, 'the stopped host is not woken again')
  assert.equal(hostWorkPaused(desk!.current!), false)

  // The settlement boundary can report the interrupt as well. It asks for no continuation and
  // changes nothing either.
  const boundary = { type: 'agent_before_settle', outcome: 'aborted', entries: [], continue: false }
  const settled = await desk!.settle(boundary as unknown as AgentBeforeSettleEvent, desk!.current!)
  assert.equal(settled, undefined)
  assert.deepEqual(await records(root, session), before, 'nor did the settlement boundary')
  await session.reload()
  assert.deepEqual(await records(root, session), before, 'nor does a reload')

  // Only the user's own confirmation naming one assignment pauses it, and it pauses that one.
  await session.prompt('pause a1')
  await quiet(session)
  assert.deepEqual(model.errors, [])
  assert.equal(model.shown('Nothing changed: assignment a2 was not paused'), 1)
  assert.equal(model.shown('Nothing changed: assignment a1 was not paused', 'already used'), 1)
  assert.ok(watch.unchangedBy('Nothing changed'), 'a refused pause changed no record')
  const after = await records(root, session)
  assert.deepEqual(
    after.map((item) => [item.id, item.state]),
    [
      ['a1', 'blocked'],
      ['a2', 'blocked'],
      ['a3', 'blocked'],
    ],
    'the one confirmed pause was used once; the host parked what it still owned',
  )
  assert.deepEqual(after[2], before[2], 'the blocked assignment was never touched')
  const paused = session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'custom' && entry.customType === 'pi-host-work'
        ? [entry.data as { assignment: string; state: string }]
        : [],
    )
    .filter((entry) => entry.state === 'paused')
    .map((entry) => entry.assignment)
  assert.deepEqual(paused, ['a1'], 'exactly one pause was ever recorded, for the named one')
})

const names = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'] as const
type Name = (typeof names)[number]

/** GAMMA and DELTA run in a second checkout, so the same rules are shown to hold across both. */
const elsewhere = (name: Name) => name === 'GAMMA' || name === 'DELTA'

type Work = {
  root: string
  session: Session
  model: ScriptedHost
  watch: ReturnType<typeof observed>
  ids: Record<Name, string>

  /** The control file of one task, read from the registry of its own checkout. */
  control(name: Name): Promise<TaskControls>

  /** Every record and every task's controls. */
  state(): Promise<string>
}

/**
 * Three assignments, each waiting on its own running task, and one task no assignment tracks.
 * a1 waits on ALPHA, a2 on BETA, a3 on DELTA; GAMMA is unbound.
 */
async function threeAssignments(
  t: { after(cleanup: () => void | Promise<void>): void },
  react: (texts: string[], other: string) => Step[] | undefined,
): Promise<Work> {
  const { root, base } = await fixture()
  const other = await fixture()
  privateAgentDirectory(t, join(await realpath(base), 'agent'))
  let session!: Session
  const ids: Record<Name, string> = { ALPHA: '', BETA: '', GAMMA: '', DELTA: '' }
  const jobs = (name: Name) => registry(elsewhere(name) ? other.root : root)
  const control = (name: Name) => controls(jobs(name), ids[name])
  const state = async () =>
    JSON.stringify([
      await records(root, session),
      await Promise.all(names.map((name) => (ids[name] ? control(name) : undefined))),
    ])
  const wait = (name: Name): Step => {
    return (context) => [
      call('host_work', {
        outcome: `Ship ${name}`,
        target: elsewhere(name) ? 'other checkout' : 'main checkout',
        state: 'waiting',
        detail: `Accept the ${name} result and deliver it.`,
        sources: [
          { task: dispatched(context, name), ...(elsewhere(name) && { project: other.root }) },
        ],
      }),
    ]
  }
  const model = new ScriptedHost((_self, texts) => {
    if (arrived(texts, 'Start the work')) {
      return [
        () =>
          names.map((name) =>
            call('delegate_task', {
              task: `${name}: update ${name.toLowerCase()}.md`,
              kind: 'documents',
              writePaths: [`${name.toLowerCase()}.md`],
              context: '',
              ...(elsewhere(name) && { project: other.root }),
            }),
          ),
        wait('ALPHA'),
        wait('BETA'),
        wait('DELTA'),
      ]
    }

    return react(texts, other.root)
  })
  const watch = observed(model, state)
  const created = await captureSession(
    root,
    base,
    [
      (pi) => {
        const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        registerDelegation(pi, async () => {}, undefined, {
          assignments,
          tickMs: fastTick,
          delivery: fastDelivery,
        })
      },
    ],
    (context) => watch.respond(context),
  )
  session = created.session
  t.after(async () => {
    await session.abort()
    session.dispose()
    await created.runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
    await rm(other.base, { recursive: true, force: true })
  })
  await session.prompt('Start the work on ALPHA, BETA, GAMMA and DELTA.')
  await quiet(session)

  for (const name of names) {
    ids[name] = await taskNamed(jobs(name), name)
  }

  assert.deepEqual(
    (await records(root, session)).map((item) => [item.id, item.state, item.owner]),
    [
      ['a1', 'waiting', `task ${ids.ALPHA}`],
      ['a2', 'waiting', `task ${ids.BETA}`],
      ['a3', 'waiting', `task ${ids.DELTA}`],
    ],
  )
  return { root, session, model, watch, ids, control, state }
}

const cancelTask = (name: Name, message?: string, project?: string): Step => {
  return (context) => [
    call('task_control', {
      id: dispatched(context, name),
      action: 'cancel',
      ...(message && { message }),
      ...(project && { project }),
    }),
  ]
}
const stop = (assignment: string, state: string, extra: Record<string, unknown> = {}): Step => {
  return () => [call('host_work', { assignment, state, detail: 'Stopped.', ...extra })]
}

// The escaped defect: task_control(cancel) took a task ID and the host's own explanation, and
// host_work(cancelled) took the host's word that the user had withdrawn the work. The calls a
// mistaken host makes are injected here exactly as it would emit them.
test('a new instruction is not authority to cancel or pause recorded work', async (t) => {
  const work = await threeAssignments(t, (texts, other) =>
    arrived(texts, 'Look at EPSILON')
      ? [

          // The incident: a task of another assignment is cancelled as "superseded".
          cancelTask('BETA', 'Superseded by the new instruction from the user.'),
          cancelTask('ALPHA', 'The user asked to stop this.'),
          cancelTask('DELTA', 'No longer the priority.', other),
          stop('a2', 'cancelled'),
          stop('a1', 'cancelled'),

          // Ambiguity never pauses, and the host cannot supply the confirmation itself.
          stop('a1', 'paused'),
          stop('a3', 'paused', {
            confirmation: { by: 'message:host', stops: [{ action: 'pause', target: 'a3' }] },
          }),
        ]
      : undefined,
  )
  const before = await work.state()
  await work.session.prompt('Look at EPSILON instead; the ALPHA idea may be obsolete.')
  await quiet(work.session)
  assert.deepEqual(work.model.errors, [])
  assert.equal(await work.state(), before, 'no record and no task control changed')
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.BETA}`), 1)
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.ALPHA}`), 1)
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.DELTA}`), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a2 was not cancelled'), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a1 was not cancelled'), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a1 was not paused'), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a3 was not paused'), 1)

  // The refusal names the confirmation the user can give for exactly this assignment.
  assert.equal(
    work.model.shown(
      'Nothing changed: assignment a1 was not cancelled',
      'reply with the line "cancel a1"',
      '/assignments cancel a1',
    ),
    1,
  )
  assert.equal(
    work.model.shown(
      `task ${work.ids.ALPHA} of assignment a1 was not cancelled`,
      `"cancel ${work.ids.ALPHA.slice(0, 8)}" for this task alone`,
    ),
    1,
  )
})

test('the user confirming one assignment cancels that one, once', async (t) => {
  const work = await threeAssignments(t, (texts) =>
    arrived(texts, 'cancel a1')
      ? [
          cancelTask('BETA', 'The user cancelled it.'),
          stop('a2', 'cancelled'),
          stop('a3', 'paused'),
          stop('a1', 'cancelled'),
          stop('a1', 'cancelled'),
        ]
      : undefined,
  )
  const others = async () =>
    JSON.stringify([
      (await records(work.root, work.session)).filter((item) => item.id !== 'a1'),
      await work.control('BETA'),
      await work.control('GAMMA'),
      await work.control('DELTA'),
    ])
  const before = await others()
  await work.session.prompt('ALPHA is no longer needed.\ncancel a1')
  await quiet(work.session)
  assert.deepEqual(work.model.errors, [])
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.BETA}`), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a2 was not cancelled'), 1)
  assert.equal(work.model.shown('Nothing changed: assignment a3 was not paused'), 1)
  assert.ok(work.watch.unchangedBy('Nothing changed'), 'a refused call changed nothing')
  assert.equal((await record(work.root, work.session, 'a1')).state, 'cancelled')
  assert.equal((await work.control('ALPHA')).cancelled, true)
  assert.equal(work.model.shown('Assignment a1 is closed (cancelled)'), 1, 'the repeat is refused')
  assert.equal(await others(), before, 'the other assignments and tasks are untouched')
})

test('the user confirming one task cancels that task and leaves its assignment open', async (t) => {
  const work = await threeAssignments(t, (texts, other) =>
    arrived(texts, 'Drop the BETA worker')
      ? [
          cancelTask('DELTA', undefined, other),
          cancelTask('ALPHA'),
          cancelTask('BETA'),
          cancelTask('BETA'),
          cancelTask('GAMMA', undefined, other),
        ]
      : undefined,
  )
  const before = JSON.stringify([
    await records(work.root, work.session),
    await work.control('ALPHA'),
    await work.control('DELTA'),
  ])
  await work.session.prompt(`Drop the BETA worker.\ncancel ${work.ids.BETA.slice(0, 8)}`)
  await quiet(work.session)
  assert.deepEqual(work.model.errors, [])
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.DELTA}`), 1)
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.ALPHA}`), 1)
  assert.equal(work.model.shown('Nothing changed', `task ${work.ids.BETA}`, 'already used'), 1)
  assert.equal((await work.control('BETA')).cancelled, true)

  // A task no assignment tracks is controlled as before.
  assert.equal((await work.control('GAMMA')).cancelled, true)
  const after = await records(work.root, work.session)
  assert.deepEqual(
    after.map((item) => [item.id, item.state]),
    [
      ['a1', 'waiting'],
      ['a2', 'waiting'],
      ['a3', 'waiting'],
    ],
  )
  assert.equal(
    JSON.stringify([
      after.map((item) => (item.id === 'a2' ? { ...item, confirmed: undefined } : item)),
      await work.control('ALPHA'),
      await work.control('DELTA'),
    ]),
    before,
    'only the use of the confirmation was recorded, on the assignment of the cancelled task',
  )
  assert.deepEqual(
    after[1]!.confirmed?.map((item) => [item.action, item.subject]),
    [['cancel', work.ids.BETA]],
  )
})

test('the /assignments command stops exactly the assignment the user names', async (t) => {
  const work = await threeAssignments(t, () => undefined)
  const requests = work.model.requests.length
  const before = await work.state()

  for (const refused of ['cancel a9', 'cancel', 'stop a1', 'cancel a1 a2', 'pause all']) {
    await work.session.prompt('/assignments ' + refused)
    assert.equal(await work.state(), before, refused + ' changed nothing')
  }

  const others = async () =>
    JSON.stringify([
      (await records(work.root, work.session)).filter((item) => item.id !== 'a3'),
      await work.control('ALPHA'),
      await work.control('BETA'),
      await work.control('GAMMA'),
    ])
  const untouched = await others()
  await work.session.prompt('/assignments pause a3')
  const paused = await record(work.root, work.session, 'a3')
  assert.deepEqual([paused.state, paused.owner], ['paused', 'user'])
  assert.equal(paused.next, 'Accept the DELTA result and deliver it.', 'the next step is kept')
  assert.equal((await work.control('DELTA')).cancelled, false, 'its worker keeps going')
  await work.session.prompt('/assignments cancel a3')
  assert.equal((await record(work.root, work.session, 'a3')).state, 'cancelled')
  assert.equal((await work.control('DELTA')).cancelled, true)
  assert.equal(await others(), untouched)
  await quiet(work.session)
  assert.equal(work.model.requests.length, requests, 'the command needs no model turn')
})
