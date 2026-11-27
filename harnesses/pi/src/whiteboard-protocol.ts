import { invariant } from './invariant.ts'
import { BoardUpgradeRequired, boardProtocol, object, type BoardReply } from './whiteboard-cli.ts'

export const batchLimit = 16
const eventLimit = 64
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const states = ['queued', 'received', 'working'] as const

// Request text and the host's answer share one bound. 4000 code points of at most four UTF-8
// bytes each always fit the 16 KiB byte bound, so the byte bound is an invariant, not a branch.
const textPoints = 4000
const textBytes = 16 * 1024

// Every Send is one sketch_notify with an optional note. A retired kind is never accepted.
// include_sketch false is a private text chat: the board shares no sketch for it.
const kinds = ['sketch_notify'] as const
export interface BoardEvent {
  id: string
  request_id?: string
  text?: string
  kind: (typeof kinds)[number]
  include_sketch: boolean
  sketch_hash: string
  created_at_ms: number
  state: (typeof states)[number]
}
export interface BoardLink {
  session: string
  owner: string
}

function invalid(): never {
  throw new Error('Invalid or mismatched whiteboard CLI response')
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,256}$/.test(value)
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function validRevision(value: unknown): value is number | string {
  return counter(value) || identifier(value)
}

function url(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) {
    return invalid()
  }

  const parsed = URL.parse(value)

  if (
    !parsed ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    return invalid()
  }

  return value
}

export function parseLink(data: BoardReply, owner: string, binding: string) {
  if (data.protocol !== boardProtocol) {
    throw new BoardUpgradeRequired()
  }

  if (!identifier(data.session) || data.owner !== owner || data.binding_file !== binding) {
    return invalid()
  }

  return {
    link: { owner, session: data.session },
    draw: url(data.draw_url),
    stage: url(data.stage_url),
  }
}

export function sameBoard(data: BoardReply, link: BoardLink) {
  if (data.session !== link.session || ('owner' in data && data.owner !== link.owner)) {
    invalid()
  }
}

/** Exact Unicode text, never trimmed or clipped: a value out of bounds is an error. */
function boundedText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.length || value.length > 2 * textPoints) {
    throw new Error(`${label} must contain 1 to ${textPoints} Unicode code points`)
  }

  let points = 0

  for (const char of value) {
    const code = char.codePointAt(0)!

    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new Error(`${label} must be Unicode without controls except tab, CR or LF`)
    }

    if (++points > textPoints) {
      throw new Error(`${label} exceeds ${textPoints} Unicode code points`)
    }
  }

  invariant(Buffer.byteLength(value) <= textBytes, 'Bounded whiteboard text exceeds 16 KiB')
  return value
}

function parseEvent(row: unknown): BoardEvent {
  if (
    !object(row) ||
    !identifier(row.id) ||
    row.id.startsWith('-') ||
    !kinds.some((kind) => kind === row.kind) ||
    ('include_sketch' in row && typeof row.include_sketch !== 'boolean') ||
    !states.some((state) => state === row.state) ||
    !identifier(row.sketch_hash) ||
    !counter(row.created_at_ms)
  ) {
    return invalid()
  }

  const event: BoardEvent = {
    id: row.id,
    kind: row.kind as BoardEvent['kind'],

    // Absent is a legacy sketch request.
    include_sketch: row.include_sketch !== false,
    state: row.state as BoardEvent['state'],
    created_at_ms: row.created_at_ms,
    sketch_hash: row.sketch_hash,
  }

  // Pre-composer journal entries may lack a request ID, but can never carry text.
  if ('request_id' in row || 'text' in row) {
    if (typeof row.request_id !== 'string' || !uuid.test(row.request_id)) {
      return invalid()
    }

    event.request_id = row.request_id
  }

  if ('text' in row) {
    event.text = boundedText(row.text, 'Whiteboard request text')
  }

  if (!event.include_sketch && event.text === undefined) {
    throw new Error('A private whiteboard chat must carry text')
  }

  return event
}

export function parsePoll(data: BoardReply, link: BoardLink) {
  if (data.protocol !== boardProtocol) {
    throw new BoardUpgradeRequired()
  }

  sameBoard(data, link)

  if (
    data.owner !== link.owner ||
    !identifier(data.sketch_hash) ||
    !validRevision(data.agent_revision) ||
    !Array.isArray(data.events) ||
    data.events.length > eventLimit
  ) {
    return invalid()
  }

  const events: BoardEvent[] = []
  const seen = new Set<string>()
  const requests = new Set<string>()

  for (const row of data.events) {
    const event = parseEvent(row)

    if (seen.has(event.id) || (event.request_id && requests.has(event.request_id))) {
      return invalid()
    }

    seen.add(event.id)

    if (event.request_id) {
      requests.add(event.request_id)
    }

    events.push(event)
  }

  return {
    ...link,
    protocol: boardProtocol,
    sketch_hash: data.sketch_hash,
    agent_revision: data.agent_revision,
    events,
  }
}

export type BoardInput = {
  action: 'status' | 'snapshot' | 'preview' | 'publish' | 'ack'
  file?: string
  event?: string
  state?: 'working' | 'updated' | 'failed'
  message?: string
}

/** The answer the paired user reads for one event. Never an option-like argv value. */
function answer(value: unknown) {
  if (value === undefined) {
    throw new Error('An updated or failed ACK needs a message answering the request')
  }

  const message = boundedText(value, 'Whiteboard answer')

  if (!/\S/u.test(message) || message.startsWith('-')) {
    throw new Error('Whiteboard answer needs visible text and must not start with "-"')
  }

  return message
}

export function boardArguments(input: BoardInput): string[] {
  if (input.action === 'status') {
    return []
  }

  if (input.action === 'ack') {
    if (
      !identifier(input.event) ||
      input.event.startsWith('-') ||
      !input.state ||
      !['working', 'updated', 'failed'].includes(input.state)
    ) {
      throw new Error('Whiteboard ack requires event and working, updated or failed state')
    }

    const event = ['--event', input.event, '--state', input.state]

    if (input.state === 'working') {
      if (input.message !== undefined) {
        throw new Error('A working ACK is not an answer. Answer with updated or failed')
      }

      return event
    }

    return [...event, '--message', answer(input.message)]
  }

  if (input.action === 'snapshot') {
    return []
  }

  // A preview and a publish read the same scene file, so what was previewed is what is saved.
  if (
    !input.file ||
    input.file.length > 4096 ||
    input.file.includes('\0') ||
    input.file.startsWith('-')
  ) {
    throw new Error('Preview and publish require a scene file')
  }

  return ['--file', input.file]
}

function artifact(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  )
}

export function canvasSnapshot(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if (
    !artifact(data.image_path) ||
    !artifact(data.records_path) ||
    !artifact(data.strokes_path) ||
    !artifact(data.scene_path) ||
    !identifier(data.snapshot) ||
    !validRevision(data.base_revision) ||
    typeof data.prompt !== 'string' ||
    !data.prompt
  ) {
    throw new Error('Whiteboard snapshot missing artifacts, revision or scene guidance')
  }

  return data
}

/** A preview is a rendering of the draft. It must say that it published nothing. */
export function preview(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if (
    !artifact(data.image_path) ||
    !identifier(data.records_hash) ||
    !counter(data.shapes_count) ||
    data.published !== false
  ) {
    return invalid()
  }

  return {
    session: link.session,
    image_path: data.image_path,
    records_hash: data.records_hash,
    shapes_count: data.shapes_count,
    published: false,
  }
}

export function publication(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if (!validRevision(data.revision) || !identifier(data.records_hash)) {
    return invalid()
  }

  return { session: link.session, revision: data.revision, records_hash: data.records_hash }
}
