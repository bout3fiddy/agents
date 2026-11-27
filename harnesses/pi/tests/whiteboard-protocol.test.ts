import assert from 'node:assert/strict'
import test from 'node:test'
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
const poll = { ...link, protocol: 3, sketch_hash: 'hash', agent_revision: 1, events: [request] }

test('event projection preserves paired request bytes but not private or ACK fields', () => {
  const row = { ...request, scoped_token: 'hidden', message: 'Working on it' }
  assert.deepEqual(parsePoll({ ...poll, events: [row] }, link).events, [request])
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

test('negotiate protocol 3 and validate the whole journal before exposing any event', () => {
  const linked = {
    ...link,
    binding_file: '/private',
    draw_url: 'http://fixture/draw',
    stage_url: 'http://fixture/stage',
  }

  for (const protocol of [undefined, 1, 2, '3']) {
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
