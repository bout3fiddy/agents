import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { invariant } from './invariant.ts'
import { object, type BoardReply } from './whiteboard-cli.ts'
import { identifier, sameBoard, type BoardLink } from './whiteboard-protocol.ts'

// The released protocol 4 native edit bounds (tldraw-sync 9476c3f). The CLI enforces them too;
// pih checks them first so an invalid file never reaches the board and errors stay fixed text.
export const editFileBytes = 1024 * 1024 + 4096
export const editOperationLimit = 800
const placeholderPattern = /^(shape|binding):new-[A-Za-z0-9_-]{1,64}$/
const requestIdPattern = /^[A-Za-z0-9_-]{8,64}$/
const editFields = ['base_sequence', 'adds', 'updates', 'deletes', 'request_id']
const editResults = {
  edit_written: 'written',
  edit_replayed: 'replayed',
  edit_unchanged: 'unchanged',
} as const

/** What pih needs to recognize the reply to one edit file. */
export interface EditRequest {
  request_id: string
  base_sequence: number
  placeholders: Set<string>
  operations: number
}

export interface EditReceipt {
  session: string
  code: keyof typeof editResults
  result: (typeof editResults)[keyof typeof editResults]
  sequence: number | null
  minted: { placeholder: string; id: string }[]
  request_id: string
}

function invalid(): never {
  throw new Error('Invalid or mismatched whiteboard CLI response')
}

// The file is the model's own work; a reason never quotes it.
function rejected(reason: string): never {
  throw new Error(`Invalid edit file: ${reason}`)
}

function sequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function baseHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

// The released plan requires all three arrays; an empty array is an ordinary value.
function operations(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    return rejected(`adds, updates and deletes must be arrays (${name} is not)`)
  }

  return value
}

function recordKind(id: string) {
  return id.slice(0, id.indexOf(':'))
}

// A record id names a shape or a binding; the board CLI owns the deeper record checks.
function recordId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^(shape|binding):./.test(value)
}

function recordShape(record: Record<string, unknown>, id: string) {
  return (
    record.typeName === recordKind(id) &&
    typeof record.type === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(record.type)
  )
}

function originalId(value: unknown): value is string {
  return recordId(value) && !placeholderPattern.test(value)
}

function addedPlaceholders(adds: unknown[], ids: Set<string>) {
  const placeholders = new Set<string>()

  for (const add of adds) {
    if (
      !object(add) ||
      !recordId(add.id) ||
      !placeholderPattern.test(add.id) ||
      ids.has(add.id) ||
      !recordShape(add, add.id)
    ) {
      return rejected('each add needs a full record with a unique placeholder id (shape:new-a)')
    }

    ids.add(add.id)
    placeholders.add(add.id)
  }

  return placeholders
}

function checkTargets(updates: unknown[], deletes: unknown[], ids: Set<string>) {
  for (const update of updates) {
    const record = object(update) ? update.record : undefined

    if (
      !object(update) ||
      !object(record) ||
      !originalId(record.id) ||
      !recordShape(record, record.id) ||
      !baseHash(update.base_hash) ||
      ids.has(record.id)
    ) {
      return rejected('each update needs the full record with a unique original id and base_hash')
    }

    ids.add(record.id)
  }

  for (const deletion of deletes) {
    if (
      !object(deletion) ||
      !originalId(deletion.id) ||
      !baseHash(deletion.base_hash) ||
      ids.has(deletion.id)
    ) {
      return rejected('each delete needs a unique original id and its base_hash')
    }

    ids.add(deletion.id)
  }
}

/** Validates the exact bytes the CLI will read and names the request ID it will use. */
export function editRequest(bytes: Buffer): EditRequest {
  if (bytes.length > editFileBytes) {
    return rejected(`over ${editFileBytes} bytes`)
  }

  let data: unknown

  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    return rejected('not JSON')
  }

  if (!object(data) || Object.keys(data).some((key) => !editFields.includes(key))) {
    return rejected('expected an object of base_sequence, adds, updates, deletes and request_id')
  }

  if (!sequenceNumber(data.base_sequence)) {
    return rejected('base_sequence must be the scene base_sequence')
  }

  const adds = operations(data.adds, 'adds')
  const updates = operations(data.updates, 'updates')
  const deletes = operations(data.deletes, 'deletes')
  const count = adds.length + updates.length + deletes.length

  if (count < 1 || count > editOperationLimit) {
    return rejected(`needs 1 to ${editOperationLimit} operations`)
  }

  const ids = new Set<string>()
  const placeholders = addedPlaceholders(adds, ids)
  checkTargets(updates, deletes, ids)
  invariant(ids.size === count, 'Each operation names a distinct record')

  if (
    data.request_id !== undefined &&
    (typeof data.request_id !== 'string' || !requestIdPattern.test(data.request_id))
  ) {
    return rejected('request_id must match /^[A-Za-z0-9_-]{8,64}$/')
  }

  // The CLI's default names the file bytes, so an identical retry replays the same edit.
  const digest = createHash('sha256').update(bytes).digest('hex')
  const request_id = data.request_id ?? 'file-' + digest.slice(0, 40)
  invariant(requestIdPattern.test(request_id), 'An edit request ID matches the CLI pattern')
  invariant(placeholders.size <= count, 'Each placeholder names one add')
  return { request_id, base_sequence: data.base_sequence, placeholders, operations: count }
}

/** `whiteboard-scene` names a private artifact; its records never pass through the reply. */
export function nativeScene(data: BoardReply, link: BoardLink) {
  invariant(link.mode === 'native', 'Only a native board has a scene')
  sameBoard(data, link)

  if (
    data.code !== 'scene_read' ||
    !sequenceNumber(data.base_sequence) ||
    typeof data.records_count !== 'number' ||
    !Number.isSafeInteger(data.records_count) ||
    data.records_count < 0 ||
    typeof data.scene_path !== 'string' ||
    data.scene_path.length > 4096 ||
    data.scene_path.includes('\0') ||
    !isAbsolute(data.scene_path)
  ) {
    return invalid()
  }

  return {
    session: link.session,
    base_sequence: data.base_sequence,
    records_count: data.records_count,
    scene_path: data.scene_path,
  }
}

function mintedRecords(value: unknown, request: EditRequest, unchanged: boolean) {
  if (!Array.isArray(value) || value.length > editOperationLimit || (unchanged && value.length)) {
    return invalid()
  }

  const minted: EditReceipt['minted'] = []
  const seen = new Set<string>()

  for (const row of value) {
    if (
      !object(row) ||
      typeof row.placeholder !== 'string' ||
      !request.placeholders.has(row.placeholder) ||
      seen.has(row.placeholder) ||
      !identifier(row.id) ||
      !row.id.startsWith(recordKind(row.placeholder) + ':')
    ) {
      return invalid()
    }

    seen.add(row.placeholder)
    minted.push({ placeholder: row.placeholder, id: row.id })
  }

  return minted
}

/** The flat success envelope of `whiteboard-edit`. It never offers a revert. */
export function editReceipt(data: BoardReply, link: BoardLink, request: EditRequest) {
  invariant(link.mode === 'native', 'Only a native board takes edits')
  sameBoard(data, link)
  const code = data.code

  if (
    typeof code !== 'string' ||
    !Object.hasOwn(editResults, code) ||
    data.result !== editResults[code as EditReceipt['code']] ||
    data.request_id !== request.request_id
  ) {
    return invalid()
  }

  const result = editResults[code as EditReceipt['code']]
  const unchanged = result === 'unchanged'

  if (unchanged ? data.sequence !== null : !sequenceNumber(data.sequence)) {
    return invalid()
  }

  const receipt: EditReceipt = {
    session: link.session,
    code: code as EditReceipt['code'],
    result,
    sequence: data.sequence as number | null,
    minted: mintedRecords(data.minted, request, unchanged),
    request_id: request.request_id,
  }
  return receipt
}
