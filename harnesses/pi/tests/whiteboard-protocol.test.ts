import assert from 'node:assert/strict'
import test from 'node:test'
import { boardProtocol } from '../src/whiteboard-cli.ts'
import {
  boardArguments,
  canvasSnapshot,
  parseLink,
  parsePoll,
  preview,
  publication,
  selectedState,
} from '../src/whiteboard-protocol.ts'

const link = { session: 'board', owner: 'host' }
const request = {
  id: 'event',
  request_id: '8ebf7683-c4ba-40b9-aae4-7fbdfbdd4803',
  kind: 'sketch_notify',
  sketch_hash: 'hash',
  created_at_ms: 1,
  state: 'working',
  text: '  \tcredential: "🦦"\r\nCafe\u0301\n ',
}
const poll = { ...link, protocol: 4, sketch_hash: 'hash', agent_revision: 1, events: [request] }

test('event projection preserves paired request bytes but not private or ACK fields', () => {
  const row = { ...request, scoped_token: 'hidden', message: 'Working on it' }
  assert.deepEqual(parsePoll({ ...poll, events: [row] }, link).events, [
    { ...request, include_sketch: true },
  ])
  const limit = '🦦'.repeat(4000)
  const parse = (text: unknown) => parsePoll({ ...poll, events: [{ ...request, text }] }, link)
  assert.equal(parse(limit).events[0]?.text, limit)

  for (const text of [limit + 'a', 'a\0b', '\x01', '\x0b', '\x1f', 3, '\ud800', '']) {
    assert.throws(() => parse(text))
  }

  for (const request_id of [undefined, 'not-a-uuid', null]) {
    assert.throws(() => parsePoll({ ...poll, events: [{ ...request, request_id }] }, link))
  }
})

test('negotiate protocol 4 and validate the whole journal before exposing any event', () => {
  assert.equal(boardProtocol, 4)
  const linked = {
    ...link,
    binding_file: '/private',
    draw_url: 'http://fixture/draw',
    stage_url: 'http://fixture/stage',
  }

  for (const protocol of [undefined, 1, 2, 3, '4']) {
    assert.throws(
      () => parseLink({ ...linked, protocol }, 'host', '/private'),
      /protocol mismatch/i,
    )
    assert.throws(() => parsePoll({ ...poll, protocol }, link), /protocol mismatch/i)
  }

  // A retired request kind is never handed to the host, whatever the board says.
  const retired = { ...request, kind: 'interpret_request' }
  assert.throws(() => parsePoll({ ...poll, events: [retired] }, link), /Invalid/)

  const rows = Array.from({ length: 64 }, (_, i) => ({
    ...request,
    id: String(i),
    request_id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
  }))
  assert.equal(parsePoll({ ...poll, events: rows }, link).events.length, 64)
  assert.throws(() => parsePoll({ ...poll, events: [...rows, request] }, link))
  assert.throws(() => parsePoll({ ...poll, events: [request, request] }, link))
  assert.throws(() => parsePoll({ ...poll, events: [request, { ...request, id: 'other' }] }, link))
})

// include_sketch false is a private chat. Absent is a legacy sketch request; anything else, or a
// chat without text, rejects the whole poll rather than guessing what the person shared.
test('include_sketch is preserved, defaults to a sketch request and is validated', () => {
  const parse = (change: Record<string, unknown>) =>
    parsePoll({ ...poll, events: [{ ...request, ...change }] }, link).events[0]

  assert.equal(parse({})?.include_sketch, true)
  assert.equal(parse({ include_sketch: true })?.include_sketch, true)
  assert.deepEqual(parse({ include_sketch: false }), { ...request, include_sketch: false })

  // A legacy row without a request ID may still say it carries the sketch.
  const { request_id: _id, text: _text, ...legacy } = request
  const old = parsePoll({ ...poll, events: [{ ...legacy, include_sketch: true }] }, link)
  assert.equal(old.events[0]?.include_sketch, true)

  for (const include_sketch of [null, 0, 1, 'false', 'true', {}, []]) {
    assert.throws(() => parse({ include_sketch }), /Invalid/, String(include_sketch))
  }

  const chat = { ...legacy, include_sketch: false }
  assert.throws(() => parsePoll({ ...poll, events: [chat] }, link), /private whiteboard chat/)
  assert.throws(() => parse({ include_sketch: false, text: '' }), /1 to 4000/)
})

test('an answer is exact bounded Unicode, required to finish and absent from working', () => {
  const ack = (state: 'working' | 'updated' | 'failed', message?: string) =>
    boardArguments({ action: 'ack', event: 'event', state, message })
  const prefix = ' I kept your 🦦.\r\n\tCafé, 感想 '
  const exact = prefix + '🦦'.repeat(4000 - [...prefix].length)
  assert.equal([...exact].length, 4000)
  assert.ok(Buffer.byteLength(exact) > 15 * 1024, 'Near the 16 KiB UTF-8 bound')

  for (const state of ['updated', 'failed'] as const) {
    const args = ack(state, exact)
    assert.deepEqual(args, ['--event', 'event', '--state', state, '--message', exact])
    assert.equal(args.at(-1), exact, 'Never trimmed, normalized or clipped')
    assert.throws(() => ack(state), /needs a message/)
    assert.throws(() => ack(state, exact + 'a'), /exceeds 4000 Unicode code points/)
    assert.throws(() => ack(state, 'a'.repeat(8001)), /1 to 4000/)

    for (const message of ['', ' \n\t', '-rm', '--binding x']) {
      assert.throws(() => ack(state, message), /1 to 4000|visible text/, JSON.stringify(message))
    }

    for (const message of ['a\0b', 'bell\x07', '\x1b[31m', 'lone \ud800', 'lone \udfff']) {
      assert.throws(() => ack(state, message), /without controls/, JSON.stringify(message))
    }
  }

  assert.deepEqual(ack('working'), ['--event', 'event', '--state', 'working'])
  assert.throws(() => ack('working', 'Here is my answer'), /working ACK is not an answer/)
  assert.throws(() => ack('working', ''), /working ACK is not an answer/)

  for (const event of [undefined, '', '-x', 'a b', 'x'.repeat(257)]) {
    assert.throws(() => boardArguments({ action: 'ack', event, state: 'updated', message: 'Hi' }))
  }
})

test('a snapshot exposes the sketch and scene artifacts and rejects a foreign reply', () => {
  const snapshot = {
    ...link,
    image_path: '/png',
    records_path: '/records',
    strokes_path: '/strokes',
    scene_path: '/scene',
    snapshot: 'hash',
    base_revision: 0,

    // The real prompt carries the scene format, so it is far longer than any path.
    prompt: 'Read the sketch. '.repeat(1000),
  }
  assert.deepEqual(canvasSnapshot(snapshot, link), snapshot)

  for (const change of [
    { strokes_path: null },
    { scene_path: undefined },
    { base_revision: -1 },
    { session: 'other' },
    { snapshot: {} },
    { prompt: '' },
    { capabilities_path: '' },
    { capabilities_path: 7 },
    { states_count: 0 },
    { states_count: 1.5 },
    { states_count: '2' },
  ]) {
    assert.throws(() => canvasSnapshot({ ...snapshot, ...change }, link), JSON.stringify(change))
  }

  // The board's capability fields pass through exactly as it wrote them.
  const described = {
    ...snapshot,
    capabilities: { controls: { max: 8 } },
    capabilities_path: '/capabilities.json',
    scene_controls: [{ id: 'theme', options: ['light', 'dark'], rest: 'light' }],
    states_count: 2,
  }
  assert.deepEqual(canvasSnapshot(described, link), described)
  const stale = { ...snapshot, states_count: null }
  assert.deepEqual(canvasSnapshot(stale, link), stale, 'A daemon without selected state')
})

test('a preview and a publish name the same scene file and nothing else', () => {
  assert.deepEqual(boardArguments({ action: 'snapshot' }), [])
  assert.deepEqual(boardArguments({ action: 'preview', file: 'p' }), ['--file', 'p'])
  assert.deepEqual(boardArguments({ action: 'publish', file: 'p' }), ['--file', 'p'])

  for (const file of [undefined, '', '-', '--binding', 'a\0b']) {
    assert.throws(() => boardArguments({ action: 'preview', file }), /scene file/)
    assert.throws(() => boardArguments({ action: 'publish', file }), /scene file/)
  }
})

// Selected state is preview-only, bounded as the board bounds it and serialized as one exact JSON
// argv value. It never reaches a publish, so the canonical scene is what is saved.
test('preview controls are bounded, exact and never reach a publish or an ACK', () => {
  const controls = { theme: 'dark', Step_2: 'b-1', z: '-x' }
  const args = boardArguments({ action: 'preview', file: 'p', controls })
  assert.deepEqual(args, ['--file', 'p', '--state', JSON.stringify(controls)])
  assert.deepEqual(JSON.parse(args[3]!), controls, 'Preserved faithfully, in order')

  const eight = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => ['c' + 'x'.repeat(38) + i, 'v'.repeat(40)]),
  )

  // Eight maximal ASCII entries serialize to 689 bytes: the board's 1024-byte bound always holds.
  assert.equal(Buffer.byteLength(JSON.stringify(eight)), 689)
  assert.deepEqual(JSON.parse(selectedState(eight).json), eight)

  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['c' + i, 'v']))

  assert.deepEqual(
    boardArguments({ action: 'preview', file: 'p', controls: {} }),
    ['--file', 'p', '--state', '{}'],
    'An explicit empty map selects the selected view at rest',
  )

  for (const bad of [
    nine,
    [],
    'theme=dark',
    null,
    { '1theme': 'dark' },
    { ['a'.repeat(41)]: 'v' },
    { 'the me': 'dark' },
    { theme: '' },
    { theme: 'v'.repeat(41) },
    { theme: 'dark mode' },
    { theme: 'dark"' },
    { theme: 3 },
    { theme: { nested: 'x' } },
    JSON.parse('{"__proto__":"x"}'),
    new Map([['theme', 'dark']]),
  ]) {
    assert.throws(
      () => boardArguments({ action: 'preview', file: 'p', controls: bad as never }),
      /preview control/i,
      JSON.stringify(bad),
    )
  }

  for (const action of ['publish', 'snapshot', 'status', 'ack'] as const) {
    assert.throws(
      () => boardArguments({ action, file: 'p', event: 'e', state: 'working', controls }),
      /Only a preview takes controls/,
      action,
    )
  }

  // ACK state stays distinct from selected state.
  for (const action of ['preview', 'publish'] as const) {
    for (const extra of [{ state: 'working' as const }, { event: 'e' }, { message: 'Hi' }]) {
      assert.throws(() => boardArguments({ action, file: 'p', ...extra }), /belong to an ACK/)
    }
  }
})

// The released protocol 4 CLI (tldraw-sync src/cli/canvas_commands.ts at a11fbeb) names the view
// on every preview. An older CLI names nothing for a static preview.
test('a preview accepts every issued rest receipt and only the requested view', () => {
  const drawn = {
    ...link,
    image_path: '/preview.png',
    records_hash: 'abc',
    shapes_count: 2,
    published: false,
  }
  const shown = { session: 'board', image_path: '/preview.png', records_hash: 'abc' }
  const rest = (change: Record<string, unknown>) => preview({ ...drawn, ...change }, link)

  // A scene without controls, a daemon that predates selected state and an older CLI.
  const empty = { view: 'rest', state: {}, states_count: 1 }
  const stale = { view: 'rest', state: null, states_count: null }
  assert.deepEqual(rest(empty), { ...shown, shapes_count: 2, ...empty, published: false })
  assert.deepEqual(rest(stale), { ...shown, shapes_count: 2, ...stale, published: false })
  assert.deepEqual(rest({}), { ...shown, shapes_count: 2, published: false })

  const resting = { theme: 'light', layout: 'grid' }
  assert.deepEqual(rest({ view: 'rest', state: resting, states_count: 4 }).state, resting)

  for (const change of [
    { view: 'selected', state: resting, states_count: 4 },
    { view: undefined, state: {}, states_count: 1 },
    { view: 'rest' },
    { view: 'rest', state: {} },
    { view: 'rest', state: {}, states_count: 0 },
    { view: 'rest', state: {}, states_count: null },
    { view: 'rest', state: null, states_count: 1 },
    { view: 'rest', state: 'theme=light', states_count: 1 },
    { view: 'rest', state: { theme: 7 }, states_count: 1 },
    { view: 'Rest', state: {}, states_count: 1 },
    { state: {} },
    { states_count: 1 },
  ]) {
    assert.throws(() => rest(change), /Invalid|requested rest view/, JSON.stringify(change))
  }
})

test('a selected preview names the selected view and draws every requested control', () => {
  const drawn = {
    ...link,
    image_path: '/preview.png',
    records_hash: 'abc',
    shapes_count: 2,
    published: false,
  }
  const selected = (requested: Record<string, string>, change: Record<string, unknown>) =>
    preview({ ...drawn, ...change }, link, requested)
  const full = { theme: 'dark', layout: 'grid' }
  const receipt = { view: 'selected', state: full, states_count: 4 }
  assert.deepEqual(selected({ theme: 'dark' }, receipt).state, full, 'Completed at rest')
  assert.equal(selected({ theme: 'dark' }, receipt).states_count, 4)
  assert.deepEqual(selected({}, receipt).state, full, 'An explicit {} is the selected view')

  // A board that drew the rest view for a selected request is never reported as selected.
  assert.throws(
    () => selected({}, { ...receipt, view: 'rest' }),
    /drew the rest view, not the requested selected view/,
  )
  assert.throws(() => selected({ theme: 'dark' }, {}), /Invalid/, 'An older CLI cannot select')

  for (const state of [{ theme: 'light' }, { layout: 'grid' }]) {
    assert.throws(
      () => selected({ theme: 'dark' }, { ...receipt, state }),
      /did not draw the requested controls/,
    )
  }

  for (const change of [
    { state: undefined },
    { state: null, states_count: null },
    { state: { theme: 7 } },
    { states_count: 0 },
    { states_count: -1 },
    { states_count: 2 ** 53 },
    { published: true },
  ]) {
    assert.throws(() => selected({}, { ...receipt, ...change }), /Invalid/, JSON.stringify(change))
  }
})

test('a preview is accepted only when it says it published nothing', () => {
  const drawn = {
    ...link,
    image_path: '/preview.png',
    records_hash: 'abc',
    shapes_count: 2,
    published: false,
  }
  const { owner: _owner, ...shown } = drawn
  assert.deepEqual(preview({ ...drawn, token: 'hidden' }, link), shown)

  for (const change of [
    { published: true },
    { published: undefined },
    { image_path: '' },
    { records_hash: 7 },
    { session: 'other' },
  ]) {
    assert.throws(() => preview({ ...drawn, ...change }, link))
  }

  const published = { ...link, revision: 3, records_hash: 'abc' }
  assert.deepEqual(publication({ ...published, title_applied: true }, link), {
    session: 'board',
    revision: 3,
    records_hash: 'abc',
  })
  assert.throws(() => publication({ ...published, revision: -1 }, link))
  assert.throws(() => publication({ ...published, session: 'other' }, link))
})
