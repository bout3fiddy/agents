import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { MissingBoardCLI } from '../src/whiteboard-cli.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { FixtureBoard, gate, ManualClock } from './whiteboard-support.ts'

const done = [{ type: 'text' as const, text: 'Done.' }]

test('command backoff is private, reports once and recovers without a model turn', async (t) => {
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
  const notices: string[] = []
  const ui = { notify: (message: string) => notices.push(message) } as unknown as ExtensionUIContext
  await session.bindExtensions({ mode: 'tui', uiContext: ui })

  // Even concurrent slash commands share the same outstanding link operation.
  const entered = gate()
  const release = gate()
  board.before = async () => {
    entered.release()
    await release.wait
  }
  const first = session.prompt('/start_whiteboard')
  await entered.wait
  const second = session.prompt('/start_whiteboard')
  release.release()
  await Promise.all([first, second])
  assert.equal(board.calls.filter((c) => c.command === 'link').length, 1)
  board.before = async () => {
    throw new Error('private diagnostic marker')
  }

  for (let i = 0; i < 7; i++) {
    assert.equal(clock.delay, i < 5 ? 2000 : 10000)
    await clock.tick()
  }

  board.before = undefined
  await clock.tick()
  assert.equal(clock.delay, 2000)
  assert.equal(steps, 0)
  assert.equal(notices.filter((s) => s.includes('Retrying')).length, 1)
  assert.equal(notices.filter((s) => s.includes('recovered')).length, 1)
  assert.match(notices[0]!, /http:\/\/fixture\/draw/)
  assert.doesNotMatch(JSON.stringify(notices), /private/)
  board.before = async () => {
    throw new MissingBoardCLI()
  }
  await clock.tick()
  assert.equal(clock.delay, undefined, 'Missing executable must not cause endless retries')
  assert.match(notices.at(-1)!, /PI_WHITEBOARD_BIN/)
})

test('foreign and unversioned polls cannot wake or acknowledge a paired request', async (t) => {
  const { root, base } = await fixture()
  const clock = new ManualClock()
  const board = new FixtureBoard()
  let corrupt: Record<string, unknown> = { owner: 'another-host' }
  const open = async (cwd: string, owner: string) => {
    const endpoint = await board.open(cwd, owner)
    return {
      ...endpoint,
      run: async (...args: Parameters<typeof endpoint.run>) => {
        const data = await endpoint.run(...args)
        return args[0] === 'poll' ? { ...data, ...corrupt } : data
      },
    }
  }
  const turns: string[] = []
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, open, clock)],
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
  board.add('notify', 'sketch_notify', 'Owning host only')
  await clock.tick()
  corrupt = { session: 'other-board' }
  await clock.tick()
  corrupt = { protocol: 1 }
  await clock.tick()
  await session.waitForIdle()
  assert.deepEqual(turns, [])
  assert.equal(clock.delay, undefined)
  assert.equal(
    board.calls.some((call) => call.command === 'ack'),
    false,
  )
  corrupt = {}
  await session.reload()
  await clock.tick()
  await session.waitForIdle()
  assert.equal(turns.length, 1)
  assert.match(turns[0]!, /Owning host only/)
})

test('fork cannot inherit a link or finish a link started by its parent', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const owners: string[] = []
  const open = async (cwd: string, owner: string) => {
    owners.push(owner)
    return board.open(cwd, owner)
  }
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, open, clock)],
    async () => done,
  )
  const release = gate()
  t.after(async () => {
    release.release()
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Parent session')
  await session.prompt('/start_whiteboard')
  const entered = gate()
  board.before = async () => {
    entered.release()
    await release.wait
  }
  const linking = session.prompt('/start_whiteboard')
  await entered.wait
  const parent = session.sessionManager.getSessionId()
  session.sessionManager.createBranchedSession(session.sessionManager.getLeafId()!)
  const child = session.sessionManager.getSessionId()
  assert.notEqual(parent, child)
  release.release()
  await linking
  await session.reload()
  assert.equal(clock.delay, undefined)
  assert.deepEqual(owners, [parent, parent])
  await session.prompt('/start_whiteboard')
  assert.deepEqual(owners, [parent, parent, child])
  assert.equal(clock.delay, 2000)
})

test('SDK tool snapshots, publishes and acknowledges in the owning session', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const actions: Record<string, string>[] = [
    { action: 'status' },
    { action: 'ack', event: 'request', state: 'working' },
    { action: 'snapshot' },
    { action: 'publish', layer: 'canvas', file: 'proposal.json' },
    { action: 'ack', event: 'request', state: 'updated', message: 'Published interpretation' },
    { action: 'publish', layer: 'ideas', file: 'legacy.json' },
    { action: 'status' },
    { action: 'snapshot', layer: 'canvas' },
    { action: 'publish', file: 'other.json' },
  ]
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async () => {
      const args = actions[step++]

      if (!args) {
        return done
      }

      if (args.file === 'other.json') {
        board.session = 'wrong-board'
      }

      return [{ type: 'toolCall', id: String(step), name: 'whiteboard', arguments: args }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('/start_whiteboard')
  const note = ' \nPlease preserve the 🦦\r\n '
  board.add('request', 'interpret_request', note)
  let snapshots = 0
  board.before = async (command) => {
    if (command === 'snapshot' && ++snapshots === 2) {
      throw new Error('Mac stage closed')
    }
  }
  await clock.tick()
  await session.waitForIdle()
  const results = session.messages.filter((m) => m.role === 'toolResult')
  assert.equal(results.length, actions.length)
  assert.deepEqual(
    results.map((m) => m.isError),
    actions.map((_, i) => i === 5 || i === 7 || i === 8),
  )
  const status = results[0]?.content[0]
  assert.ok(status?.type === 'text')
  assert.equal(JSON.parse(status.text).events[0].text, note)
  assert.match(JSON.stringify(results[0]?.content), /interpret_request/)
  assert.match(JSON.stringify(results[2]?.content), /diagram_path/)
  assert.match(JSON.stringify(results[5]?.content), /fresh canvas snapshot/)
  assert.doesNotMatch(JSON.stringify(results[6]?.content), /interpret_request/)
  assert.match(JSON.stringify(results[7]?.content), /stage closed/)
  assert.match(JSON.stringify(results[8]?.content), /mismatched/)
  assert.equal(board.calls.filter((c) => c.command === 'publish').length, 1)
  assert.deepEqual(
    board.calls.filter((c) => c.command === 'ack').map((c) => c.args[3]),
    ['received', 'working', 'updated'],
  )
  assert.deepEqual(board.calls.find((c) => c.command === 'publish')?.args, [
    '--layer',
    'canvas',
    '--file',
    'proposal.json',
  ])
})
