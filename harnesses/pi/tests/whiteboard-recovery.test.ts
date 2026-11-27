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

  // Escaped gap: this schedule also appended a retired host-work pause entry that nothing reads
  // any more, and asserted it suppressed wakes. Only the default seed avoided that coincidence.
  for (let tick = 0; tick < 24; tick++) {
    failPoll = next() % 6 === 0
    failReceipt = next() % 4 === 0

    if (next() % 4 === 0) {
      await session.reload()
    }

    const shape = next() % 3
    board.add(
      `event-${tick}`,
      shape === 2 ? undefined : shape ? 'A note' : 'A private question',
      shape ? undefined : false,
    )
    const count = batches().length
    await clock.tick()
    await session.waitForIdle()

    if (failPoll) {
      assert.equal(batches().length, count)
    }
  }

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
