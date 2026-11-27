import assert from 'node:assert/strict'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { registerDelegation } from '../src/delegation-tools.ts'
import { registerHostWork } from '../src/host-work.ts'
import { captureSession } from './session-support.ts'
import { generator, simulationSeeds } from './simulation.ts'
import { fixture } from './support.ts'
import {
  ScriptedHost,
  arrived,
  boundOutcomes,
  call,
  continued,
  controls,
  dispatched,
  fastDelivery,
  fastTick,
  faultyWakes,
  finish,
  noFaults,
  plain,
  privateAgentDirectory,
  quiet,
  receipts,
  record,
  records,
  registry,
  taskNamed,
  until,
  type Step,
} from './assignment-support.ts'

const events = ['fail', 'cross', 'cancel', 'focus', 'duplicate'] as const
type Event = (typeof events)[number]

/**
 * A replayable schedule: the independent events in a seeded order. The duplicate completion
 * belongs to the retry of GAMMA, so it always follows GAMMA's failure.
 */
function schedule(seed: number): Event[] {
  const next = generator(seed)
  const order: Event[] = ['fail', 'cross', 'cancel', 'focus']

  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    const moved = order[index]!
    order[index] = order[other]!
    order[other] = moved
  }

  const earliest = order.indexOf('fail') + 1
  order.splice(earliest + Math.floor(next() * (order.length - earliest + 1)), 0, 'duplicate')
  return order
}

const targets = { a1: 'main checkout', a2: 'other checkout', a3: 'main checkout' }

// Three unrelated jobs advance independently. Every event after dispatch except the explicit
// cancel and the side question happens with no user input: the test only lets a worker end.
for (const seed of simulationSeeds(3)) {
  const order = schedule(seed)
  const title = `three assignments advance independently: seed ${seed} (${order.join(' → ')})`

  test(title, async (t) => {
    const host = await fixture()
    const other = await fixture()
    privateAgentDirectory(t, join(await realpath(host.base), 'agent'))
    const otherRoot = await realpath(other.root)
    const faults = noFaults()
    const state = { retried: false, rejections: [] as string[], gamma: '' }
    const open = (name: string, id: keyof typeof targets): Step => {
      return (context) => [
        call('host_work', {
          outcome: `Ship ${name}`,
          target: targets[id],
          state: 'waiting',
          detail: `Accept the ${name} result and deliver it.`,
          sources: [{ task: dispatched(context, name) }],
        }),
      ]
    }
    const close = (id: keyof typeof targets, target: string): Step => {
      return () => [
        call('host_work', {
          assignment: id,
          state: 'done',
          detail: 'Delivered and verified.',
          evidence: { target, revision: `${id}-r1` },
        }),
      ]
    }
    const retryGamma: Step[] = [
      () => [
        call('delegate_task', {
          task: 'GAMMA retry: update gamma.md',
          kind: 'documents',
          writePaths: ['gamma.md'],
          context: '',
        }),
      ],
      (context) => [
        call('host_work', {
          assignment: 'a3',
          state: 'waiting',
          detail: 'Accept the second GAMMA attempt.',
          sources: [{ task: dispatched(context, 'GAMMA retry') }],
        }),
      ],
    ]

    // A preview is offered first as if it were delivery. The runtime must refuse it.
    const closeGamma: Step[] = [
      close('a3', 'preview'),
      (context) => {
        state.rejections.push(plain(context.messages.at(-1)))
        return close('a3', targets.a3)(context)
      },
    ]
    const advance = (model: ScriptedHost, id: string, status: string): Step[] => {
      if (model.closed.has(id)) {
        return []
      }

      if (id === 'a3' && status === 'failed' && !state.retried) {
        state.retried = true
        return retryGamma
      }

      if (id === 'a3' && status === 'complete') {
        return closeGamma
      }

      return id === 'a2' && status === 'complete' ? [close('a2', targets.a2)] : []
    }
    const model = new ScriptedHost((self, texts) => {
      const outcome = arrived(texts, 'Background task outcome.')
      const handedBack = arrived(texts, 'The host owns the next step')

      if (outcome) {
        return boundOutcomes(outcome).flatMap((item) => advance(self, item.assignment, item.state))
      }

      if (handedBack) {
        return continued(handedBack).flatMap((item) => advance(self, item.assignment, item.state))
      }

      if (arrived(texts, 'Start ALPHA')) {
        return [
          () => [
            call('delegate_task', {
              task: 'ALPHA: update alpha.md',
              kind: 'documents',
              writePaths: ['alpha.md'],
              context: '',
            }),
            call('delegate_task', {
              task: 'BETA: inspect the other checkout',
              kind: 'research',
              writePaths: [],
              context: '',
              project: other.root,
            }),
            call('delegate_task', {
              task: 'GAMMA: update gamma.md',
              kind: 'documents',
              writePaths: ['gamma.md'],
              context: '',
            }),
          ],
          open('ALPHA', 'a1'),

          // No project: the origin index of this session locates the task in the other checkout.
          open('BETA', 'a2'),
          open('GAMMA', 'a3'),
        ]
      }

      if (arrived(texts, 'Cancel ALPHA')) {
        const withdraw = (assignment: string): Step => {
          return () => [
            call('host_work', {
              assignment,
              state: 'cancelled',
              detail: 'The user withdrew ALPHA.',
            }),
          ]
        }
        return [

          // The mistaken calls first: the user confirmed a1 and nothing else. Whether GAMMA is
          // still running or already delivered at this point of the schedule, neither changes.
          () => [
            call('task_control', {
              id: state.gamma,
              action: 'cancel',
              message: 'Superseded by the cancellation of ALPHA.',
            }),
          ],
          withdraw('a3'),
          withdraw('a1'),
        ]
      }

      return undefined
    })
    const { session, runtime } = await captureSession(
      host.root,
      host.base,
      [
        (pi) => {
          const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
          registerDelegation(faultyWakes(pi, faults), async () => {}, undefined, {
            assignments,
            tickMs: fastTick,
            delivery: fastDelivery,
          })
        },
      ],
      model.respond,
    )
    t.after(async () => {
      await session.abort()
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(host.base, { recursive: true, force: true })
      await rm(other.base, { recursive: true, force: true })
    })
    const here = registry(host.root)
    const there = registry(other.root)
    await session.prompt('Hello.')
    const beforeDispatch = session.sessionManager.getLeafId()!
    await session.prompt('Start ALPHA, BETA and GAMMA and deliver each.')
    await quiet(session)
    const alpha = await taskNamed(here, 'ALPHA')
    const gamma = await taskNamed(here, 'GAMMA:')
    state.gamma = gamma
    const beta = await taskNamed(there, 'BETA')
    assert.deepEqual(
      (await records(host.root, session)).map((item) => [item.id, item.state, item.owner]),
      [
        ['a1', 'waiting', `task ${alpha}`],
        ['a2', 'waiting', `task ${beta}`],
        ['a3', 'waiting', `task ${gamma}`],
      ],
    )
    assert.equal((await record(host.root, session, 'a2')).sources[0]?.kind, 'task')
    assert.deepEqual(
      (await record(host.root, session, 'a2')).sources.map((source) =>
        source.kind === 'task' ? source.project : '',
      ),
      [otherRoot],
    )

    // Everything an event must leave alone: the other assignments and their tasks' controls.
    const untouched = async (touched: string) => {
      const others = (await records(host.root, session)).filter((item) => item.id !== touched)
      const cancelled = await Promise.all([
        ...(touched === 'a1' ? [] : [controls(here, alpha)]),
        ...(touched === 'a2' ? [] : [controls(there, beta)]),
        ...(touched === 'a3' ? [] : [controls(here, gamma)]),
      ])
      return JSON.stringify([others, cancelled])
    }
    const run: Record<Event, () => Promise<void>> = {
      async fail() {
        const before = await untouched('a3')
        await finish(here, gamma, 'failed', 'GAMMA first attempt failed')
        await until(async () => {
          const item = await record(host.root, session, 'a3')
          return item.state === 'waiting' && item.sources.some((source) => !source.settled)
        }, 'GAMMA to be retried')
        await quiet(session)
        const item = await record(host.root, session, 'a3')
        assert.equal(item.attempts, 1)
        assert.equal(item.history.at(-1)?.status, 'failed')
        assert.equal(await untouched('a3'), before)
      },
      async cross() {
        const before = await untouched('a2')
        const dropped = faults.dropped
        faults.drop = 1
        await finish(there, beta, 'complete', 'BETA finished in the other checkout')
        await until(
          async () => (await record(host.root, session, 'a2')).state === 'done',
          'BETA to be delivered after its wake was dropped',
        )
        await quiet(session)
        assert.equal(faults.dropped, dropped + 1, 'the first wake really was dropped')
        assert.equal(receipts(session, beta), 1, 'the outcome is persisted exactly once')
        assert.equal(await untouched('a2'), before)
      },
      async duplicate() {
        const before = await untouched('a3')
        const retry = await taskNamed(here, 'GAMMA retry')
        faults.duplicate = 1
        await finish(here, retry, 'complete', 'GAMMA second attempt finished')
        await until(
          async () =>
            (await record(host.root, session, 'a3')).state === 'done' &&
            receipts(session, retry) === 2,
          'GAMMA to be delivered and its duplicate to arrive',
        )
        await quiet(session)
        assert.equal(faults.duplicated, 1)
        assert.equal((await record(host.root, session, 'a3')).attempts, 2)
        assert.equal(
          model.shown('Background task outcome.', retry),
          1,
          'the model is asked to act on the outcome once',
        )
        assert.equal(model.shown('Repeated delivery', retry), 1, 'the copy says it is a copy')
        assert.equal(await untouched('a3'), before)
      },
      async cancel() {
        const before = await untouched('a1')
        await session.prompt('Cancel ALPHA only.\ncancel a1')
        await quiet(session)
        assert.equal((await record(host.root, session, 'a1')).state, 'cancelled')
        assert.equal((await controls(here, alpha)).cancelled, true)
        assert.equal(await untouched('a1'), before)
      },
      async focus() {
        const before = JSON.stringify([
          await records(host.root, session),
          await controls(here, alpha),
          await controls(there, beta),
          await controls(here, gamma),
        ])
        const requests = model.requests.length
        await session.navigateTree(beforeDispatch, { summarize: false })
        await session.prompt('Unrelated: what should we have for lunch?')
        await quiet(session)
        assert.equal(model.requests.length, requests + 1, 'a side question is one answer')
        assert.equal(
          JSON.stringify([
            await records(host.root, session),
            await controls(here, alpha),
            await controls(there, beta),
            await controls(here, gamma),
          ]),
          before,
          'changing focus changes no assignment and stops no worker',
        )
      },
    }

    for (const event of order) {
      await run[event]()
    }

    assert.deepEqual(model.errors, [])
    const final = await records(host.root, session)
    assert.deepEqual(
      final.map((item) => [item.id, item.state, item.attempts]),
      [
        ['a1', 'cancelled', 0],
        ['a2', 'done', 1],
        ['a3', 'done', 2],
      ],
    )
    assert.deepEqual(
      final[2]!.history.map((item) => item.status),
      ['failed', 'complete'],
    )

    // The preview could not close GAMMA: only evidence for its own target is recorded.
    assert.equal(state.rejections.length, 1)
    assert.match(state.rejections[0]!, /A candidate, preview or other target does not close it/)
    assert.deepEqual(
      final[2]!.evidence.map((item) => [item.target, item.closes]),
      [[targets.a3, true]],
    )

    // No action was repeated: four dispatches, one close per delivered assignment.
    assert.equal(model.count('delegate_task'), 4)
    assert.equal(
      model.count('host_work', (args) => args.state === 'done' && args.assignment === 'a2'),
      1,
    )
    assert.equal(
      model.count('host_work', (args) => args.state === 'done' && args.assignment === 'a3'),
      2,
    )
    assert.deepEqual(
      model.actions
        .filter(({ name, args }) => name === 'host_work' && args.state === 'cancelled')
        .map(({ args }) => args.assignment as string),
      ['a3', 'a1'],
      'the mistaken cancellation was attempted and only the confirmed one took effect',
    )
    assert.equal(model.count('task_control'), 1)

    // The cancel reached ALPHA's task and nothing else.
    const retry = await taskNamed(here, 'GAMMA retry')
    assert.deepEqual(
      await Promise.all([
        controls(here, alpha),
        controls(there, beta),
        controls(here, gamma),
        controls(here, retry),
      ]).then((all) => all.map((item) => [item.cancelled, item.paused ?? false])),
      [
        [true, false],
        [false, false],
        [false, false],
        [false, false],
      ],
    )
    assert.equal(receipts(session, gamma), 1)
    assert.equal(receipts(session, alpha), 0)
  })
}
