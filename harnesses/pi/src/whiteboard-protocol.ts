import { object, type BoardReply } from './whiteboard-cli.ts'

export const batchLimit = 16
const eventLimit = 1024
const states = ['queued', 'received', 'working'] as const
const kinds = ['sketch_notify', 'interpret_request'] as const
export interface BoardEvent {
  id: string
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

// CAS tokens belong to the individual layer, not to the poll change counter.
export function validRevision(value: unknown) {
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

export function parsePoll(data: BoardReply, link: BoardLink) {
  sameBoard(data, link)

  if (
    data.owner !== link.owner ||
    !identifier(data.sketch_hash) ||
    !counter(data.agent_revision) ||
    !Array.isArray(data.events) ||
    data.events.length > eventLimit
  ) {
    return invalid()
  }

  const events: BoardEvent[] = []
  const seen = new Set<string>()

  for (const row of data.events) {
    if (
      !object(row) ||
      !identifier(row.id) ||
      row.id.startsWith('-') ||
      seen.has(row.id) ||
      !kinds.some((kind) => kind === row.kind) ||
      !states.some((state) => state === row.state) ||
      !identifier(row.sketch_hash) ||
      !counter(row.created_at_ms)
    ) {
      return invalid()
    }

    seen.add(row.id)
    events.push({
      id: row.id,
      kind: row.kind as BoardEvent['kind'],
      state: row.state as BoardEvent['state'],
      created_at_ms: row.created_at_ms,
      sketch_hash: row.sketch_hash,
    })
  }

  return { ...link, sketch_hash: data.sketch_hash, agent_revision: data.agent_revision, events }
}

export type BoardInput = {
  action: 'status' | 'snapshot' | 'publish' | 'ack'
  layer?: 'interpretation' | 'ideas'
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

  if (input.layer !== 'interpretation' && input.layer !== 'ideas') {
    throw new Error('Choose whiteboard layer interpretation or ideas')
  }

  const args = ['--layer', input.layer]

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

export function publication(data: BoardReply, link: BoardLink, layer: BoardInput['layer']) {
  sameBoard(data, link)

  if (data.layer !== layer || !validRevision(data.revision)) {
    return invalid()
  }

  return { session: link.session, layer, revision: data.revision }
}
