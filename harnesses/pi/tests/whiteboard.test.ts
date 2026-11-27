import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { boardMessage } from '../src/whiteboard-feed.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { FixtureBoard, gate, ManualClock } from './whiteboard-support.ts'

const done = [{ type: 'text' as const, text: 'Done.' }]

test('user input wins; mixed requests append once and recover a lost ACK', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const first = gate()
  const release = gate()
  const turns: string[] = []
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async (context) => {
      turns.push(JSON.stringify(context.messages.at(-1)?.content))

      if (turns.length === 1) {
        first.release()
        await release.wait
      }

      return done
    },
  )
  t.after(async () => {
    release.release()
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const receipts = () =>
    session.sessionManager
      .getBranch()
      .filter((e) => e.type === 'custom_message' && e.customType === boardMessage)
  await session.prompt('/start_whiteboard')
  await session.prompt('/start_whiteboard')
  await clock.tick()
  assert.deepEqual(turns, [], 'Commands and empty polls do not invoke the model')
  const work = session.prompt('First user request')
  await first.wait
  board.add('notify', 'Typed notify')
  board.add('drawn', 'Typed drawing')
  await clock.tick()
  assert.equal(receipts().length, 0)
  await session.followUp('Priority user follow-up')
  release.release()
  await work
  await session.waitForIdle()
  assert.equal(turns.length, 3)
  assert.match(turns[1]!, /Priority user follow-up/)
  assert.match(turns[2]!, /sketch_notify/)
  assert.match(turns[2]!, /Typed notify/)
  assert.match(turns[2]!, /Typed drawing/)
  assert.equal(receipts().length, 1)
  let attempts = 0
  board.before = async (command) => {
    if (command === 'ack') {
      assert.equal(receipts().length, 1, 'Received ACK requires actual transcript append')

      if (!attempts++) {
        throw new Error('daemon down before commit')
      }
    }
  }
  await clock.tick()
  assert.equal(board.events[0]?.state, 'queued')
  await session.reload()
  board.add('new')
  await clock.tick()
  assert.deepEqual(
    board.events.map((e) => e.state),
    ['received', 'received', 'queued'],
  )
  assert.equal(receipts().length, 1, '5s wake throttle survives reload')
  await clock.tick()
  await session.waitForIdle()
  assert.equal(receipts().length, 2)
  assert.equal(turns.length, 4)
  assert.doesNotMatch(turns.at(-1)!, /Typed drawing/)
  await session.prompt('/stop_whiteboard')
  await session.reload()
  assert.equal(clock.delay, undefined)
  assert.equal(board.calls.filter((c) => c.command === 'link').length, 2)
})

test('a dropped draft is retried without an ACK', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const first = gate()
  const release = gate()
  let steps = 0
  let dropped = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerWhiteboard(pi, board.open, clock)
        pi.on('turn_end', (event) => {
          if (
            event.entries.some((e) => e.type === 'custom_message' && e.customType === boardMessage)
          ) {
            dropped++
            return { entries: [], continue: false }
          }
        })
      },
    ],
    async () => {
      if (++steps === 1) {
        first.release()
        await release.wait
      }

      return done
    },
  )
  t.after(async () => {
    release.release()
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('/start_whiteboard')
  const work = session.prompt('Working')
  await first.wait
  board.add('request', 'Park this request until resumed.')
  await clock.tick()
  release.release()
  await work
  assert.equal(dropped, 1)
  assert.equal(steps, 1)

  // The request the host never received is offered again once its backoff has passed.
  for (let i = 0; i < 4; i++) {
    await clock.tick()
  }

  await clock.tick()
  await session.waitForIdle()
  assert.equal(steps, 2)
  await clock.tick()
  assert.equal(board.events[0]?.state, 'received')
})

test('an unavailable ACK does not starve the next wake', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const turns: string[] = []
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async (context) => {
      turns.push(JSON.stringify(context.messages.at(-1)?.content))
      return done
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('/start_whiteboard')
  board.add('first')
  await clock.tick()
  await session.waitForIdle()
  board.before = async (command, args) => {
    if (command === 'ack' && args[1] === 'first') {
      throw new Error('First event rejected')
    }
  }
  board.add('second', 'Second note')

  for (let i = 0; i < 6; i++) {
    await clock.tick()
    await session.waitForIdle()
  }

  assert.equal(turns.length, 2)
  assert.match(turns[1]!, /Second note/)
  assert.deepEqual(
    board.events.map((e) => e.state),
    ['queued', 'received'],
  )
})

test('fresh session waits for its transcript file before first ACK', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const entered = gate()
  const release = gate()
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async () => {
      entered.release()
      await release.wait
      return done
    },
  )
  t.after(async () => {
    release.release()
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('/start_whiteboard')
  board.add('first')
  await clock.tick()
  await entered.wait
  await clock.tick()
  assert.equal(board.events[0]?.state, 'queued', 'SDK has not flushed setup-only entries')
  release.release()
  await session.waitForIdle()
  await clock.tick()
  assert.equal(board.events[0]?.state, 'received')
})

// Escaped gap: the receipt check guarded only queued events, so a sibling branch could finish a
// request another branch had already received and was answering.
test('a sibling branch cannot answer a request delivered on another branch', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async (context) => {
      const last = context.messages.at(-1)
      const content = JSON.stringify(last?.content)
      const ack = (state: string, message?: string) => [
        {
          type: 'toolCall' as const,
          id: state,
          name: 'whiteboard',
          arguments: { action: 'ack', event: 'chat', state, ...(message && { message }) },
        },
      ]

      if (last?.role === 'toolResult') {
        return done
      }

      if (content.includes('Request data (JSON)')) {
        return ack('working')
      }

      return content.includes('Answer from the sibling') ? ack('updated', 'Sibling reply') : done
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Before linking')
  await session.prompt('/start_whiteboard')
  const linkedLeaf = session.sessionManager.getLeafId()!
  board.add('chat', 'A private question', false)
  await clock.tick()
  await session.waitForIdle()
  assert.equal(board.events[0]?.state, 'working')
  await session.navigateTree(linkedLeaf, { summarize: false })
  await session.prompt('Answer from the sibling')
  const result = session.messages.findLast((m) => m.role === 'toolResult')
  assert.equal(result?.isError, true)
  assert.match(JSON.stringify(result?.content), /not been delivered in this conversation/)
  assert.deepEqual(
    board.calls.filter((c) => c.command === 'ack').map((c) => c.args[3]),
    ['received', 'working'],
  )
  assert.equal(board.events[0]?.state, 'working')
})

test('tree change cancels in-flight polls without a stale wake or ACK', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  let steps = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async () => {
      steps++
      return done
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Before linking')
  const leaf = session.sessionManager.getLeafId()!
  await session.prompt('/start_whiteboard')
  const linkedLeaf = session.sessionManager.getLeafId()!
  board.add('previous')
  await clock.tick()
  await session.waitForIdle()
  await clock.tick()
  await session.navigateTree(linkedLeaf, { summarize: false })

  for (let tick = 0; tick < 3; tick++) {
    await clock.tick()
    await session.waitForIdle()
  }

  assert.equal(steps, 2, 'A sibling branch must not wake again for an already delivered event')
  board.add('stale')
  const entered = gate()
  const release = gate()
  let active: AbortSignal | undefined
  board.before = async (_command, _args, signal) => {
    active = signal
    entered.release()
    await release.wait
  }
  const poll = clock.tick()
  await entered.wait
  assert.equal(clock.delay, undefined, 'No second timer during a poll')
  await session.navigateTree(leaf, { summarize: false })
  assert.equal(active?.aborted, true)
  release.release()
  await poll
  assert.equal(clock.delay, undefined)
  assert.equal(steps, 2)
  assert.equal(board.events[1]?.state, 'queued')
})
