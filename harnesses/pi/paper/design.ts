import { randomUUID } from 'node:crypto'
import { block, exact, isId } from './surface.ts'
import { fail, limits, object, Wire } from './protocol.ts'

export interface Target {
  fileId: string
  pageId: string
  nodeIds: string[]
}

export function validTarget(target: Target) {
  return (
    isId(target.fileId) &&
    isId(target.pageId) &&
    Array.isArray(target.nodeIds) &&
    target.nodeIds.length <= limits.nodes &&
    Array.from(target.nodeIds).every(isId) &&
    new Set(target.nodeIds).size === target.nodeIds.length
  )
}

const reads = {
  get_basic_info: ['fileId', 'pageId'],
  get_selection: ['fileId'],
  get_node_info: ['fileId', 'nodeId'],
  get_children: ['fileId', 'nodeId'],
  get_screenshot: ['fileId', 'nodeId'],
}
const writes = {
  create_artboard: ['fileId', 'pageId', 'name', 'styles'],
  write_html: ['fileId', 'targetNodeId', 'mode', 'html'],
}

function supports(
  schemas: Map<string, Record<string, unknown>>,
  required: Record<string, string[]>,
) {
  return Object.entries(required).every(([name, fields]) => {
    const properties = schemas.get(name)
    return properties && fields.every((field) => Object.hasOwn(properties, field))
  })
}

function jsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {

    // Plain text is display data only. It cannot confer authority on a node.
    return undefined
  }
}

function boardList(info: unknown, target: Target) {
  if (!object(info) || info.fileId !== target.fileId || info.pageId !== target.pageId) {
    return
  }

  if (!Array.isArray(info.artboards) || info.artboards.length > 256) {
    return
  }

  const boards = new Map<string, string>()

  for (const board of info.artboards) {
    if (
      !object(board) ||
      !isId(board.id) ||
      typeof board.name !== 'string' ||
      boards.has(board.id)
    ) {
      return
    }

    boards.set(board.id, board.name)
  }

  return boards
}

function png(content: Record<string, unknown>) {
  const { type, mimeType, data } = content

  if (type !== 'image' || mimeType !== 'image/png' || typeof data !== 'string') {
    fail('protocol')
  }

  if (data.length > Math.ceil(limits.imageBytes / 3) * 4) {
    fail('limit')
  }

  const bytes = Buffer.from(data, 'base64')

  if (bytes.length > limits.imageBytes) {
    fail('limit')
  }

  if (bytes.length < 33 || bytes.toString('base64') !== data) {
    fail('protocol')
  }

  if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    fail('protocol')
  }

  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail('protocol')
  }

  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)

  if (!width || !height || width > 4096 || height > 4096 || width * height > 4194304) {
    fail('limit')
  }

  return { type: 'image' as const, mimeType: 'image/png' as const, data }
}

/** Created once per attachment. Caller serializes operations and guards every wire request. */
export class Design {
  private readonly target: Target
  private readonly wire: Wire
  private readonly check: () => void
  private readonly owned = new Map<string, string>()
  private images = 0
  writable = false

  constructor(target: Target, wire: Wire, check: () => void) {
    this.target = target
    this.wire = wire
    this.check = check
  }

  private async content(name: string, args: Record<string, unknown>) {
    this.check()
    const content = await this.wire.invoke(name, { ...args, fileId: this.target.fileId })
    this.check()
    return content
  }

  private async text(name: string, args: Record<string, unknown>) {
    const data = await this.content(name, args)

    if (data.type !== 'text' || typeof data.text !== 'string') {
      fail('protocol')
    }

    if (Buffer.byteLength(data.text) > limits.textBytes) {
      fail('limit')
    }

    const value = jsonText(data.text)

    if (object(value)) {
      for (const key of ['fileId', 'pageId'] as const) {
        if (key in value && value[key] !== this.target[key]) {
          fail('wrong_target')
        }
      }

      if ('nodeId' in args && 'nodeId' in value && value.nodeId !== args.nodeId) {
        fail('wrong_target')
      }

      if (name === 'get_node_info' && 'id' in value && value.id !== args.nodeId) {
        fail('wrong_target')
      }
    }

    return { type: 'text' as const, text: data.text }
  }

  private page() {
    return this.text('get_basic_info', { pageId: this.target.pageId })
  }

  async initialize(draftTargetingVerified: boolean) {
    const { schemas, probedVersion } = await this.wire.discover(this.check)

    if (!supports(schemas, reads)) {
      fail('unsupported')
    }

    const overview = await this.page()
    this.writable =
      draftTargetingVerified &&
      probedVersion &&
      supports(schemas, writes) &&
      boardList(jsonText(overview.text), this.target) !== undefined
    return overview
  }

  private hasNode(nodeId: unknown): nodeId is string {
    return isId(nodeId) && (this.target.nodeIds.includes(nodeId) || this.owned.has(nodeId))
  }

  private async selection() {
    const result = jsonText((await this.text('get_selection', {})).text)

    if (!object(result) || !Array.isArray(result.selectedNodeIds)) {
      fail('unsupported')
    }

    const ids = result.selectedNodeIds.filter((id) => this.hasNode(id))
    return { type: 'text' as const, text: JSON.stringify(ids) }
  }

  private async newBoard() {
    if (this.owned.size >= limits.boards) {
      fail('limit')
    }

    const before = boardList(jsonText((await this.page()).text), this.target)

    if (!before || before.size >= 256) {
      fail('wrong_target')
    }

    const name = `pih-draft-${randomUUID()}`
    const styles = { width: '1024px', height: '768px' }
    const created = await this.text('create_artboard', { pageId: this.target.pageId, name, styles })
    const board = jsonText(created.text)

    if (!object(board) || !isId(board.id) || before.has(board.id) || this.hasNode(board.id)) {
      fail('wrong_target')
    }

    const after = boardList(jsonText((await this.page()).text), this.target)

    if (after?.get(board.id) !== name) {
      fail('wrong_target')
    }

    this.owned.set(board.id, name)
    return { type: 'text' as const, text: JSON.stringify({ boardId: board.id, name }) }
  }

  private async append(args: Record<string, unknown>) {
    const html = block(args)
    const id = args.boardId

    if (!isId(id) || !this.owned.has(id)) {
      fail('denied')
    }

    const boards = boardList(jsonText((await this.page()).text), this.target)

    if (!boards || boards.get(id) !== this.owned.get(id)) {
      fail('wrong_target')
    }

    await this.text('write_html', { targetNodeId: id, mode: 'insert-children', html })
    return { type: 'text' as const, text: 'appended' }
  }

  async dispatch(name: string, args: unknown) {
    if (name === 'paper_new_draft' || name === 'paper_append') {
      if (!this.writable) {
        fail('read_only')
      }

      if (name === 'paper_append' && object(args)) {
        return this.append(args)
      }

      if (name !== 'paper_new_draft' || !exact(args, [])) {
        fail('invalid')
      }

      return this.newBoard()
    }

    if (name === 'paper_page' || name === 'paper_selection') {
      if (!exact(args, [])) {
        fail('invalid')
      }

      return name === 'paper_page' ? this.page() : this.selection()
    }

    if (!exact(args, ['nodeId'])) {
      fail('invalid')
    }

    const nodeId = args.nodeId

    if (!this.hasNode(nodeId)) {
      fail('denied')
    }

    if (name === 'paper_node') {
      return this.text('get_node_info', { nodeId })
    }

    if (name === 'paper_children') {
      return this.text('get_children', { nodeId })
    }

    if (name !== 'paper_screenshot') {
      fail('denied')
    }

    if (++this.images > limits.images) {
      fail('limit')
    }

    return png(await this.content('get_screenshot', { nodeId }))
  }
}
