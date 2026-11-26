import { BoardUpgradeRequired, object, type BoardReply } from './whiteboard-cli.ts'

export const batchLimit = 16
const eventLimit = 64
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const states = ['queued', 'received', 'working'] as const
const kinds = ['sketch_notify', 'interpret_request'] as const
export interface BoardEvent {
  id: string
  request_id?: string
  text?: string
  kind: (typeof kinds)[number]
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
  if (data.protocol !== 2) {
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

function requestText(value: unknown) {
  if (typeof value !== 'string' || !value.length || value.length > 8000) {
    throw new Error('Whiteboard request text must contain 1 to 4000 Unicode code points')
  }

  let points = 0

  for (const char of value) {
    const code = char.codePointAt(0)!

    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new Error('Whiteboard text must be Unicode without controls except tab, CR or LF')
    }

    if (++points > 4000) {
      throw new Error('Whiteboard request text exceeds 4000 Unicode code points')
    }
  }

  return value
}

function parseEvent(row: unknown): BoardEvent {
  if (
    !object(row) ||
    !identifier(row.id) ||
    row.id.startsWith('-') ||
    !kinds.some((kind) => kind === row.kind) ||
    !states.some((state) => state === row.state) ||
    !identifier(row.sketch_hash) ||
    !counter(row.created_at_ms)
  ) {
    return invalid()
  }

  const event: BoardEvent = {
    id: row.id,
    kind: row.kind as BoardEvent['kind'],
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
    event.text = requestText(row.text)
  }

  return event
}

export function parsePoll(data: BoardReply, link: BoardLink) {
  if (data.protocol !== 2) {
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
    protocol: 2,
    sketch_hash: data.sketch_hash,
    agent_revision: data.agent_revision,
    events,
  }
}

export type BoardInput = {
  action: 'status' | 'snapshot' | 'publish' | 'ack'
  layer?: 'canvas' | 'interpretation' | 'ideas'
  file?: string
  event?: string
  state?: 'working' | 'updated' | 'failed'
  message?: string
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

    if (
      input.message &&
      (input.message.length > 512 || input.message.includes('\0') || input.message.startsWith('-'))
    ) {
      throw new Error('Invalid whiteboard status message')
    }

    return [
      '--event',
      input.event,
      '--state',
      input.state,
      ...(input.message ? ['--message', input.message] : []),
    ]
  }

  if (input.layer !== undefined && input.layer !== 'canvas') {
    throw new Error('Use a fresh canvas snapshot and preserve the entire unified Agent diagram.')
  }

  const args = ['--layer', 'canvas']

  if (input.action === 'publish') {
    if (
      !input.file ||
      input.file.length > 4096 ||
      input.file.includes('\0') ||
      input.file.startsWith('-')
    ) {
      throw new Error('Publish requires a proposal file')
    }

    args.push('--file', input.file)
  }

  return args
}

function artifact(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  )
}

export function canvasSnapshot(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if ('layer' in data && data.layer !== 'canvas') {
    throw new Error('Whiteboard snapshot belongs to a different layer')
  }

  if (
    !artifact(data.path) ||
    !artifact(data.records_path) ||
    !artifact(data.strokes_path) ||
    !artifact(data.diagram_path) ||
    (data.previous_diagram_path != null && !artifact(data.previous_diagram_path)) ||
    !identifier(data.snapshot) ||
    !validRevision(data.base_revision) ||
    typeof data.prompt !== 'string' ||
    !data.prompt ||
    !(
      (typeof data.publish_command === 'string' && data.publish_command.length > 0) ||
      (Array.isArray(data.publish_command) &&
        data.publish_command.length > 0 &&
        data.publish_command.every((arg) => typeof arg === 'string'))
    )
  ) {
    throw new Error(
      'Whiteboard canvas snapshot missing artifacts, revision or publication guidance',
    )
  }

  return data
}

export function publication(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if (data.layer !== 'canvas' || !validRevision(data.revision)) {
    return invalid()
  }

  return { session: link.session, layer: data.layer, revision: data.revision }
}
