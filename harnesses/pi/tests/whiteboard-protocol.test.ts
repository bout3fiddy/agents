import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boardArguments,
  canvasSnapshot,
  parseLink,
  parsePoll,
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
const poll = { ...link, protocol: 2, sketch_hash: 'hash', agent_revision: 1, events: [request] }

test('v2 event projection preserves paired request bytes but not private or ACK fields', () => {
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

test('negotiate v2 and validate the whole journal before exposing any event', () => {
  const linked = {
    ...link,
    binding_file: '/private',
    draw_url: 'http://fixture/draw',
    stage_url: 'http://fixture/stage',
  }

  for (const protocol of [undefined, 1, '2']) {
    assert.throws(() => parseLink({ ...linked, protocol }, 'host', '/private'), /upgrade/i)
    assert.throws(() => parsePoll({ ...poll, protocol }, link), /upgrade/i)
  }

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

test('canvas snapshot exposes unified artifacts and rejects an incomplete or foreign reply', () => {
  const snapshot = {
    ...link,
    path: '/png',
    records_path: '/records',
    strokes_path: '/strokes',
    diagram_path: '/diagram',
    previous_diagram_path: null,
    snapshot: 'hash',
    base_revision: 0,
    prompt: 'Interpret current sketch',
    publish_command: 'whiteboard-publish',
    layer: 'canvas',
  }
  assert.deepEqual(canvasSnapshot(snapshot, link), snapshot)

  for (const change of [
    { strokes_path: null },
    { base_revision: -1 },
    { session: 'other' },
    { layer: 'ideas' },
    { snapshot: {} },
    { previous_diagram_path: 17 },
  ]) {
    assert.throws(() => canvasSnapshot({ ...snapshot, ...change }, link))
  }
})

test('use one canvas revision; do not reinterpret a legacy layer write as a replacement', () => {
  assert.deepEqual(boardArguments({ action: 'snapshot' }), ['--layer', 'canvas'])
  assert.deepEqual(boardArguments({ action: 'publish', layer: 'canvas', file: 'p' }), [
    '--layer',
    'canvas',
    '--file',
    'p',
  ])

  for (const layer of ['ideas', 'interpretation'] as const) {
    assert.throws(() => boardArguments({ action: 'publish', layer, file: 'p' }), /canvas/)
    assert.throws(() => publication({ ...link, layer, revision: 1 }, link))
  }
})
