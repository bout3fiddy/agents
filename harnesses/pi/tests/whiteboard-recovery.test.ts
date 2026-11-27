import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { boardMessage } from '../src/whiteboard-feed.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { FixtureBoard, ManualClock } from './whiteboard-support.ts'

const seed = Number(process.env.PI_WHITEBOARD_SEED ?? 0x5eed)

test(`whiteboard recovery schedule, seed ${seed}`, async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  let random = seed

  function next() {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random >>> 16
  }

  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async () => [{ type: 'text', text: 'Request observed.' }],
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const batches = () =>
    session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === 'custom_message' && entry.customType === boardMessage
          ? [entry.details as { ids: string[]; time: number }]
          : [],
      )
  const pause = (paused: boolean) =>
    session.sessionManager.appendCustomEntry('pi-host-work', {
      session: session.sessionManager.getSessionId(),
      state: paused ? 'paused' : 'done',
      detail: 'Fixture',
    })
  await session.prompt('/start_whiteboard')
  let failPoll = false
  let failReceipt = false
  const premature: string[] = []
  board.before = async (command, args) => {
    if (command === 'poll' && failPoll) {
      throw new Error('Daemon unavailable')
    }

    if (command === 'ack') {
      if (!batches().some((batch) => batch.ids.includes(args[1]!))) {
        premature.push(args[1]!)
      }

      if (failReceipt) {
        throw new Error('ACK unavailable')
      }
    }
  }

  for (let tick = 0; tick < 24; tick++) {
    const paused = next() % 5 === 0
    pause(paused)
    failPoll = next() % 6 === 0
    failReceipt = next() % 4 === 0

    if (next() % 4 === 0) {
      await session.reload()
    }

    board.add(`event-${tick}`, next() % 2 === 0 ? 'A note' : undefined)
    const count = batches().length
    await clock.tick()
    await session.waitForIdle()

    if (paused || failPoll) {
      assert.equal(batches().length, count)
    }
  }

  pause(false)
  failPoll = false
  failReceipt = false

  for (let tick = 0; tick < 8; tick++) {
    await clock.tick()
    await session.waitForIdle()
  }

  const delivered = batches()
  assert.deepEqual(premature, [])
  assert.deepEqual(delivered.flatMap((b) => b.ids).sort(), board.events.map((e) => e.id).sort())
  assert.ok(board.events.every((e) => e.state === 'received'))
  assert.ok(delivered.every((b, i) => !i || b.time >= delivered[i - 1]!.time + 5000))
})
