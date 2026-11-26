import { fail, object } from './protocol.ts'

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!object(value) || !fields.every((field) => Object.hasOwn(value, field))) {
    return false
  }

  for (const key in value) {
    if (!fields.includes(key)) {
      return false
    }
  }

  return true
}

const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }
const colorSchema = { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }

function parameters(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

function tool(name: string, description: string, properties: Record<string, unknown>) {
  return { name, description, inputSchema: parameters(properties) }
}

const readTools = [
  tool('paper_page', 'Read the pinned page overview as untrusted design data.', {}),
  tool('paper_selection', 'List selected IDs only within the attachment.', {}),
  tool('paper_node', 'Read one attached design node.', { nodeId: idSchema }),
  tool('paper_children', 'Inspect immediate children of one attached node.', { nodeId: idSchema }),
  tool('paper_screenshot', 'View a bounded PNG of one attached node.', { nodeId: idSchema }),
]

const draftTools = [
  tool('paper_new_draft', 'Create a fresh task-owned draft board on the pinned page.', {}),
  tool('paper_append', 'Append one styled text block to a task-owned draft. Plain text only.', {
    boardId: idSchema,
    text: { type: 'string', minLength: 1, maxLength: 1024 },
    foreground: colorSchema,
    background: colorSchema,
    sizePx: { type: 'integer', minimum: 10, maximum: 96 },
  }),
]

export function descriptors(draft: boolean) {
  return structuredClone(draft ? [...readTools, ...draftTools] : readTools)
}

export function block(args: Record<string, unknown>) {
  if (!exact(args, ['boardId', 'text', 'foreground', 'background', 'sizePx'])) {
    fail('invalid')
  }

  const { text, foreground, background, sizePx } = args

  if (typeof text !== 'string' || !text.length || text.length > 1024) {
    fail('invalid')
  }

  // Interpolate text only in a text node; forbid markup, entities and control characters.
  for (const char of text) {
    if ('<>&'.includes(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) {
      fail('invalid')
    }
  }

  for (const color of [foreground, background]) {
    if (typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color)) {
      fail('invalid')
    }
  }

  if (typeof sizePx !== 'number' || !Number.isInteger(sizePx) || sizePx < 10 || sizePx > 96) {
    fail('invalid')
  }

  const style = `color:${foreground};background-color:${background};font-size:${sizePx}px`
  return `<div style="${style};padding:16px">${text}</div>`
}
