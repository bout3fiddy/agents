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
  ]) {
    assert.throws(() => canvasSnapshot({ ...snapshot, ...change }, link))
  }
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
