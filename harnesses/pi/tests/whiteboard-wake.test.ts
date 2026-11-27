import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import type { BoardEvent } from '../src/whiteboard-protocol.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { FixtureBoard, ManualClock } from './whiteboard-support.ts'

test('SDK delivers complete FIFO batches within both budgets across reload', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const wakes: string[] = []
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async (context) => {
      const content = context.messages.at(-1)?.content
      const text =
        typeof content === 'string'
          ? content
          : content?.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      wakes.push(text ?? '')
      return [{ type: 'text', text: 'Seen.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('/start_whiteboard')
  const note = ' \t{"authorization":"example"}\r\nCafe\u0301 🦦 \n '

  for (let i = 0; i < 64; i++) {
    const text = i < 5 ? '🦦'.repeat(4000) : i % 2 ? note : undefined
    board.add(String(i), text)
  }

  const expected = structuredClone(board.events)
  await clock.tick()
  await session.waitForIdle()
  await session.reload()

  for (let tick = 0; tick < 30; tick++) {
    await clock.tick()
    await session.waitForIdle()
  }

  const batches = wakes.map((wake) => {
    const json = wake.slice(wake.indexOf('\n') + 1)
    assert.ok(Buffer.byteLength(json) <= 32 * 1024, 'UTF-8 wake budget')
    const rows = JSON.parse(json) as BoardEvent[]
    assert.ok(rows.length > 0 && rows.length <= 16)
    return rows
  })
  assert.deepEqual(batches.flat(), expected)
  assert.ok(board.events.every((e) => e.state === 'received'))
})
