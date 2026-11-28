import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExtensionUIContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { BoardCommandFailed, openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { editReceipt, editRequest, nativeScene } from '../src/whiteboard-native.ts'
import { parseLink } from '../src/whiteboard-protocol.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { FixtureBoard, ManualClock } from './whiteboard-support.ts'

const done = [{ type: 'text' as const, text: 'Done.' }]
const native = { session: 'board', owner: 'host', mode: 'native' as const }

// The disposable record the board's own server tests add.
export const firstShape = (parentId: string) => ({
  id: 'shape:new-first',
  typeName: 'shape',
  type: 'draw',
  x: 100,
  y: 100,
  rotation: 0,
  index: 'a1',
  parentId,
  isLocked: false,
  opacity: 1,
  meta: {},
  props: {
    color: 'black',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    segments: [
      {
        type: 'free',
        points: [
          { x: 0, y: 0, z: 0.5 },
          { x: 10, y: 2, z: 0.5 },
        ],
      },
    ],
    isComplete: true,
    isClosed: false,
    isPen: true,
    scale: 1,
  },
})

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const addition = { base_sequence: 3, adds: [firstShape('page:page')], updates: [], deletes: [] }

test('an edit file is checked against the released schema before the CLI runs', () => {
  const file = bytes(addition)
  const request = editRequest(file)
  const digest = createHash('sha256').update(file).digest('hex')
  assert.equal(request.request_id, 'file-' + digest.slice(0, 40))
  assert.deepEqual([...request.placeholders], ['shape:new-first'])
  assert.equal(
    editRequest(bytes({ ...addition, request_id: 'retry_ID-1' })).request_id,
    'retry_ID-1',
  )

  const h = 'a'.repeat(64)
  const empty = { base_sequence: 1, adds: [], updates: [], deletes: [] }
  const record = { id: 'shape:abc', typeName: 'shape', type: 'draw', x: 1 }
  const update = { record, base_hash: h }
  assert.equal(editRequest(bytes({ ...empty, updates: [update] })).operations, 1)
  const many = Array.from({ length: 800 }, (_, i) => ({ id: 'shape:o' + i, base_hash: h }))
  assert.equal(editRequest(bytes({ ...empty, deletes: many })).operations, 800)
  const binding = { id: 'binding:b1', base_hash: h }
  const longest = { id: 'shape:' + 'x'.repeat(250), base_hash: h }
  assert.equal(editRequest(bytes({ ...empty, deletes: [binding, longest] })).operations, 2)

  // Each array is required, even when the edit does not use it (released native_scene_plan).
  for (const name of ['adds', 'updates', 'deletes'] as const) {
    const { [name]: _omitted, ...rest } = addition
    assert.throws(() => editRequest(bytes(rest)), /adds, updates and deletes must be arrays/)
  }

  const shape = firstShape('page:page')
  const invalid: [unknown, RegExp][] = [
    [[], /expected an object/],
    [{ ...addition, extra: 1 }, /expected an object/],
    [{ ...addition, base_sequence: 0 }, /base_sequence/],
    [{ ...addition, base_sequence: '3' }, /base_sequence/],
    [{ ...addition, base_sequence: undefined }, /base_sequence/],
    [empty, /1 to 800 operations/],
    [{ ...empty, deletes: [...many, { id: 'shape:x', base_hash: h }] }, /1 to 800/],
    [{ ...addition, adds: {} }, /must be arrays \(adds is not\)/],
    [{ ...addition, deletes: null }, /must be arrays \(deletes is not\)/],
    [{ ...addition, adds: [{ ...shape, id: 'shape:first' }] }, /placeholder/],
    [{ ...addition, adds: [{ ...shape, id: 'page:new-x', typeName: 'page' }] }, /placeholder/],
    [{ ...addition, adds: [{ ...shape, typeName: 'binding' }] }, /placeholder/],
    [{ ...addition, adds: [{ ...shape, type: 'bad type' }] }, /placeholder/],
    [{ ...addition, adds: [shape, shape] }, /placeholder/],
    [{ ...empty, updates: [{ record: { ...record, type: undefined }, base_hash: h }] }, /update/],
    [{ ...empty, updates: [{ record: { ...record, typeName: 'binding' } }] }, /update/],
    [{ ...empty, updates: [{ ...update, base_hash: 'h1' }] }, /base_hash/],
    [{ ...empty, updates: [{ ...update, base_hash: 'A'.repeat(64) }] }, /base_hash/],
    [{ ...empty, updates: [{ record: { ...shape }, base_hash: h }] }, /original id/],
    [{ ...empty, deletes: [{ id: 'shape:new-first', base_hash: h }] }, /original id/],
    [{ ...empty, deletes: [{ id: 'page:page', base_hash: h }] }, /original id/],
    [{ ...empty, deletes: [{ id: 'shape:' + 'x'.repeat(251), base_hash: h }] }, /original id/],
    [{ ...empty, updates: [update], deletes: [{ id: 'shape:abc', base_hash: h }] }, /unique/],
    [{ ...addition, request_id: 'short' }, /request_id/],
    [{ ...addition, request_id: 'has space here' }, /request_id/],
    [{ ...addition, request_id: 'x'.repeat(65) }, /request_id/],
  ]

  for (const [value, reason] of invalid) {
    assert.throws(() => editRequest(bytes(value)), reason, JSON.stringify(value).slice(0, 80))
  }

  assert.throws(() => editRequest(Buffer.from('{')), /not JSON/)
  const padded = Buffer.from(JSON.stringify(addition).padEnd(1024 * 1024 + 4097))
  assert.throws(() => editRequest(padded), /over 1052672 bytes/)
  assert.equal(editRequest(padded.subarray(0, 1024 * 1024 + 4096)).operations, 1)
})

test('scene and edit replies must match the flat released envelopes', () => {
  const scene = {
    status: 'success',
    code: 'scene_read',
    session: 'board',
    base_sequence: 3,
    records_count: 0,
    scene_path: '/private/scene.json',
  }
  assert.deepEqual(nativeScene(scene, native), {
    session: 'board',
    base_sequence: 3,
    records_count: 0,
    scene_path: '/private/scene.json',
  })

  for (const change of [
    { code: 'edit_written' },
    { base_sequence: 0 },
    { base_sequence: 1.5 },
    { records_count: -1 },
    { scene_path: 'relative/scene.json' },
    { session: 'other' },
  ]) {
    assert.throws(() => nativeScene({ ...scene, ...change }, native), /mismatched/)
  }

  assert.throws(() => nativeScene(scene, { ...native, mode: 'legacy' }), /Invariant/)

  const request = editRequest(bytes(addition))
  const minted = [{ placeholder: 'shape:new-first', id: 'shape:minted' }]
  const written = {
    status: 'success',
    code: 'edit_written',
    session: 'board',
    result: 'written',
    sequence: 4,
    minted,
    request_id: request.request_id,
  }
  assert.deepEqual(editReceipt(written, native, request), {
    session: 'board',
    code: 'edit_written',
    result: 'written',
    sequence: 4,
    minted,
    request_id: request.request_id,
  })
  const replayed = { ...written, code: 'edit_replayed', result: 'replayed' }
  assert.equal(editReceipt(replayed, native, request).result, 'replayed')
  const unchanged = { ...written, code: 'edit_unchanged', result: 'unchanged' }
  const same = { ...unchanged, sequence: null, minted: [] }
  assert.equal(editReceipt(same, native, request).sequence, null)

  for (const reply of [
    { ...written, result: 'replayed' },
    { ...written, code: 'edit_reverted' },
    { ...written, sequence: null },
    { ...written, sequence: 0 },
    { ...replayed, sequence: null },
    { ...same, sequence: 4 },
    { ...same, minted },
    { ...written, minted: [{ placeholder: 'shape:new-other', id: 'shape:x' }] },
    { ...written, minted: [{ placeholder: 'shape:new-first', id: 'binding:x' }] },
    { ...written, minted: [...minted, ...minted] },
    { ...written, minted: undefined },
    { ...written, request_id: 'file-other-request' },
    { ...written, session: 'other' },
  ]) {
    assert.throws(() => editReceipt(reply, native, request), /mismatched/, JSON.stringify(reply))
  }
})

test('a native link must echo native; a legacy link must not claim it', () => {
  const linked = {
    protocol: 4,
    status: 'success',
    code: 'linked',
    session: 'board',
    owner: 'host',
    binding_file: '/private',
    draw_url: 'http://fixture/draw',
    stage_url: 'http://fixture/stage',
  }
  assert.equal(
    parseLink({ ...linked, native: true }, 'host', '/private', 'native').link.mode,
    'native',
  )
  assert.equal(parseLink(linked, 'host', '/private', 'legacy').link.mode, 'legacy')
  assert.equal(
    parseLink({ ...linked, native: false }, 'host', '/private', 'legacy').link.mode,
    'legacy',
  )

  for (const value of [undefined, false, 'true', 1]) {
    assert.throws(
      () => parseLink({ ...linked, native: value }, 'host', '/private', 'native'),
      /did not confirm a native board/,
    )
  }

  assert.throws(
    () => parseLink({ ...linked, native: true }, 'host', '/private', 'legacy'),
    /linked a native board/,
  )
})

// A scripted CLI that reports each released failure shape, quoting private content in its
// message and stderr exactly as a real failure may.
const cli = `#!/usr/bin/env node
const fs = require('node:fs')
const [command, ...args] = process.argv.slice(2)
const field = (name) => args[args.indexOf(name) + 1]
const reply = { status: 'success', session: 'board', owner: 'host', protocol: 4 }
if (command === 'whiteboard-link') {
  fs.writeFileSync(field('--out'), 'private-binding-marker', { mode: 0o600 })
  Object.assign(reply, { code: 'linked', binding_file: field('--out'), args,
    native: args.includes('--native'), draw_url: 'http://lan/draw', stage_url: 'http://lan/s' })
  console.log(JSON.stringify(reply))
  process.exit(0)
}
if (fs.readFileSync(field('--binding'), 'utf8') !== 'private-binding-marker') process.exit(9)
if (command === 'whiteboard-scene') {
  console.log(JSON.stringify({ ...reply, code: 'scene_read', base_sequence: 1, records_count: 1,
    scene_path: '/private/scene.json', args }))
  process.exit(0)
}
const mode = fs.readFileSync(field('--file'), 'utf8').trim()
const fail = (code, exit) => {
  console.error('private-marker')
  console.log(JSON.stringify({ status: 'failure', code, message: 'quoted private-marker' }))
  process.exit(exit)
}
if (mode === 'stale') fail('stale', 5)
if (mode === 'diverged') fail('diverged', 5)
if (mode === 'reused') fail('request_id_reused', 1)
if (mode === 'legacy') fail('not_native', 1)
if (mode === 'daemon') fail('daemon_unreachable', 1)
if (mode === 'crash') fail('internal', 3)
if (mode === 'garbled') { console.log('private-marker {'); process.exit(0) }
console.log(JSON.stringify({ ...reply, args }))
`

test('the CLI adapter passes native argv and classifies every edit failure', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-native-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const bin = join(root, 'cli.cjs')
  await writeFile(bin, cli, { mode: 0o700 })
  const override = process.env.PI_WHITEBOARD_BIN
  t.after(() => {
    if (override === undefined) {
      delete process.env.PI_WHITEBOARD_BIN
    } else {
      process.env.PI_WHITEBOARD_BIN = override
    }
  })
  process.env.PI_WHITEBOARD_BIN = bin
  const endpoint = await openBoardEndpoint(root, 'host')
  const signal = new AbortController().signal
  const linked = await endpoint.run('link', ['--native'], signal)
  assert.deepEqual(linked.args, [
    '--owner',
    'host',
    '--out',
    endpoint.binding,
    '--protocol',
    '4',
    '--native',
    '--json',
  ])
  assert.equal(parseLink(linked, 'host', endpoint.binding, 'native').link.mode, 'native')
  const scene = await endpoint.run('scene', [], signal)
  assert.deepEqual(scene.args, ['--binding', endpoint.binding, '--json'])
  const file = join(root, 'edit file.json')
  await writeFile(file, 'written')
  const edited = await endpoint.run('edit', ['--file', file], signal)
  assert.deepEqual(edited.args, ['--binding', endpoint.binding, '--file', file, '--json'])

  // Settled: the board certainly wrote nothing. Unknown: only the identical file may follow.
  const outcomes: [string, boolean, RegExp][] = [
    ['stale', true, /conflicts with the board\. Read the scene again/],
    ['diverged', true, /conflicts with the board/],
    ['reused', true, /rejected\. That request_id named a different edit/],
    ['legacy', true, /rejected\. This board is not native/],
    ['daemon', false, /outcome is unknown\. Resend the identical file/],
    ['crash', false, /outcome is unknown/],
    ['garbled', false, /outcome is unknown/],
  ]

  for (const [mode, settled, message] of outcomes) {
    await writeFile(file, mode)
    await assert.rejects(endpoint.run('edit', ['--file', file], signal), (error: Error) => {
      assert.ok(error instanceof BoardCommandFailed, mode)
      assert.equal(error.settled, settled, mode)
      assert.match(error.message, message)
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /private-marker|edit file/)
      return true
    })
  }
})

// Writes one edit file in the session project and returns its path relative to it.
async function editFile(root: string, name: string, value: unknown) {
  await writeFile(join(root, name), JSON.stringify(value))
  return { name, request: editRequest(bytes(value)) }
}

function linkEntries(session: { sessionManager: { getEntries(): SessionEntry[] } }) {
  return session.sessionManager
    .getEntries()
    .flatMap((e) => (e.type === 'custom' && e.customType === 'pi-whiteboard-link' ? [e.data] : []))
}

test('a new board is native: scene, atomic edit and the unknown-outcome retry rule', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const first = await editFile(root, 'first.json', addition)
  const second = await editFile(root, 'second.json', { ...addition, request_id: 'second-edit' })
  const actions: Record<string, string>[] = [
    { action: 'status' },
    { action: 'snapshot' },
    { action: 'preview', file: first.name },
    { action: 'scene' },
    { action: 'edit', file: first.name },
    { action: 'edit', file: second.name },
    { action: 'edit', file: first.name },
    { action: 'edit', file: second.name },
    { action: 'edit', file: second.name },
    { action: 'scene' },
    { action: 'edit', file: first.name },
    { action: 'edit', file: 'missing.json' },
  ]
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, clock)],
    async () => {
      const args = actions[step++]
      const call = { type: 'toolCall' as const, id: String(step), name: 'whiteboard' }
      return args ? [{ ...call, arguments: args }] : done
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })

  // CLI calls: the first reply is lost after the board may have applied it, so a different file
  // is refused until the identical one is resent (call 2). A conflict settles (call 3); an
  // unknown outcome (call 4) is cleared by a fresh scene read, after which call 5 differs.
  let edits = 0
  board.before = async (command, args) => {
    if (command !== 'edit') {
      return
    }

    edits++
    board.requestId = args[1]!.endsWith('first.json') ? first.request.request_id : 'second-edit'

    if (edits === 1) {
      throw new Error('reply lost')
    }

    if (edits === 3) {
      assert.equal(board.requestId, 'second-edit')
      throw new BoardCommandFailed('Whiteboard edit conflicts with the board.', true)
    }

    if (edits === 4) {
      throw new BoardCommandFailed('Whiteboard edit outcome is unknown.', false)
    }
  }
  await session.prompt('/start_whiteboard')
  assert.deepEqual(board.calls, [{ command: 'link', args: ['--native'] }])
  const owner = session.sessionManager.getSessionId()
  assert.deepEqual(linkEntries(session), [{ owner, session: 'board-1', mode: 'native' }])
  await session.prompt('Draw on the native board')
  const results = session.messages.filter((m) => m.role === 'toolResult')
  const text = (i: number) => {
    const part = results[i]?.content[0]
    assert.ok(part?.type === 'text')
    return part.text
  }
  assert.deepEqual(
    results.map((m) => m.isError),
    [false, true, true, false, true, true, false, true, true, false, false, true],
  )
  assert.equal(JSON.parse(text(0)).mode, 'native')
  assert.match(text(1), /native board: use scene and edit; it has no snapshot, preview or publish/)
  assert.match(text(2), /native board/)
  assert.equal(JSON.parse(text(3)).scene_path, '/private/scene.json')
  assert.match(text(5), /previous edit outcome is unknown\. Resend that identical file/)
  assert.equal(JSON.parse(text(6)).result, 'written')
  assert.equal(JSON.parse(text(6)).request_id, first.request.request_id)
  assert.match(text(7), /conflicts with the board/)
  assert.match(text(8), /outcome is unknown/)
  assert.deepEqual(JSON.parse(text(10)).minted, [
    { placeholder: 'shape:new-first', id: 'shape:minted2' },
  ])
  assert.match(text(11), /not a readable file/)

  // Never the legacy verbs, and each edit names its file by absolute path.
  const commands = board.calls.map((c) => c.command)
  assert.ok(!commands.some((c) => ['snapshot', 'preview', 'publish'].includes(c)))
  assert.deepEqual(
    board.calls.filter((c) => c.command === 'edit').map((c) => c.args),
    ['first', 'first', 'second', 'second', 'first'].map((name) => [
      '--file',
      join(root, name + '.json'),
    ]),
  )
})

test('an existing legacy session keeps its board, mode and stage tools unchanged', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  const clock = new ManualClock()
  const actions: Record<string, string>[] = [
    { action: 'scene' },
    { action: 'edit', file: 'scene.json' },
    { action: 'preview', file: 'scene.json' },
    { action: 'publish', file: 'scene.json' },
  ]
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerWhiteboard(pi, board.open, clock)

        // A link recorded before native boards existed: no mode field.
        pi.registerCommand('seed_old_link', {
          description: 'test only',
          handler: async (_args, ctx) => {
            pi.appendEntry('pi-whiteboard-link', {
              owner: ctx.sessionManager.getSessionId(),
              session: 'board-1',
            })
          },
        })
      },
    ],
    async (context) => {
      if (!JSON.stringify(context.messages).includes('Draw on the legacy board')) {
        return done
      }

      const args = actions[step++]
      const call = { type: 'toolCall' as const, id: String(step), name: 'whiteboard' }
      return args ? [{ ...call, arguments: args }] : done
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
  await session.prompt('Before the board')
  await session.prompt('/seed_old_link')
  await session.reload()
  assert.equal(clock.delay, 2000, 'The saved legacy link resumes listening')
  assert.equal(board.calls.length, 0, 'Restoring never relinks')

  // An explicit native request is refused before the CLI; the default keeps legacy.
  await session.prompt('/start_whiteboard native')
  assert.equal(board.calls.length, 0)
  assert.match(notices.at(-1)!, /whiteboard is legacy and stays legacy/)
  await session.prompt('/start_whiteboard bogus')
  assert.match(notices.at(-1)!, /Usage: \/start_whiteboard \[native\|legacy\]/)
  await session.prompt('/start_whiteboard')
  assert.deepEqual(board.calls, [{ command: 'link', args: [] }])
  assert.deepEqual(linkEntries(session).at(-1), {
    owner: session.sessionManager.getSessionId(),
    session: 'board-1',
    mode: 'legacy',
  })
  await session.prompt('Draw on the legacy board')
  const results = session.messages.filter((m) => m.role === 'toolResult')
  assert.deepEqual(
    results.map((m) => m.isError),
    [true, true, false, false],
  )
  assert.match(JSON.stringify(results[0]?.content), /legacy board: use snapshot, preview/)
  assert.deepEqual(
    board.calls.map((c) => c.command).filter((c) => c !== 'poll'),
    ['link', 'preview', 'publish'],
  )

  // Detaching keeps the recorded mode; a later start still refuses native.
  await session.prompt('/stop_whiteboard')
  await session.prompt('/start_whiteboard --native')
  assert.match(notices.at(-1)!, /stays legacy/)
  assert.equal(board.calls.filter((c) => c.command === 'link').length, 1)
})

test('a legacy request never relabels a binding that has no recorded mode', async (t) => {
  const { root, base } = await fixture()
  const board = new FixtureBoard()
  board.binding = join(base, 'existing-binding.json')
  await writeFile(board.binding, 'private', { mode: 0o600 })
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerWhiteboard(pi, board.open, new ManualClock())],
    async () => done,
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const notices: string[] = []
  const ui = { notify: (message: string) => notices.push(message) } as unknown as ExtensionUIContext
  await session.bindExtensions({ mode: 'tui', uiContext: ui })
  await session.prompt('Before the board')
  await session.prompt('/start_whiteboard legacy')
  assert.equal(board.calls.length, 0)
  assert.match(notices.at(-1)!, /no recorded mode/)

  // A native request is safe: the CLI refuses a legacy binding rather than converting it.
  await session.prompt('/start_whiteboard')
  assert.deepEqual(board.calls, [{ command: 'link', args: ['--native'] }])
})
