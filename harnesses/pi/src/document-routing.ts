import { extname, resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'

export const documentBudget = { files: 1, calls: 2, bytes: 2000, steps: 4 }
const document = (path: string) => ['.md', '.txt', '.rst'].includes(extname(path).toLowerCase())

type Attempt = { path: string; bytes: number }

function attempt(name: string, input: Record<string, unknown>, cwd: string): Attempt | undefined {
  if (
    !['write', 'edit'].includes(name) ||
    typeof input.path !== 'string' ||
    !document(input.path)
  ) {
    return undefined
  }

  const parts =
    name === 'write'
      ? [input.content]
      : Array.isArray(input.edits)
        ? input.edits.flatMap((edit) => [edit.oldText, edit.newText])
        : [input.oldText, input.newText]
  return {
    path: resolve(cwd, input.path).normalize('NFKC').toLowerCase(),
    bytes: parts.reduce<number>(
      (size, part) => size + (typeof part === 'string' ? Buffer.byteLength(part) : 0),
      0,
    ),
  }
}

export function documentShellWrite(command: string): boolean {
  const docs = /\.(?:md|txt|rst)\b/i.test(command)
  const script =
    /(?:^|[\s;&|])(?:python[\d.]*|node|ruby|perl)\b/.test(command) &&
    /write_text\s*\(|write_bytes\s*\(|writeFile(?:Sync)?\s*\(|open\([^\n]*['"](?:w|a|x)/.test(
      command,
    )
  const shell =
    /(?:^|[\n;&|])\s*(?:cat\b[^\n]*>|tee\b|cp\b|mv\b|rm\b|sed\s+-\w*i)/.test(command) ||
    />\s*[^\s;|&]*\.(?:md|txt|rst)\b/i.test(command)
  return docs && (script || shell)
}

function recent(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch()
  const user = branch.findLastIndex(
    (entry) => entry.type === 'message' && entry.message.role === 'user',
  )
  return branch.slice(user + 1)
}

export function documentRoute(event: ToolCallEvent, ctx: ExtensionContext): string | undefined {
  if (
    event.toolName === 'document_check' &&
    event.input.format === true &&
    Array.isArray(event.input.paths) &&
    event.input.paths.length > documentBudget.files
  ) {
    return 'Formatting multiple documents belongs in a background document task.'
  }

  if (
    event.toolName === 'bash' &&
    typeof event.input.command === 'string' &&
    documentShellWrite(event.input.command)
  ) {
    return 'Document rewrites through shell scripts belong in a background document task.'
  }

  const current = attempt(event.toolName, event.input, ctx.cwd)

  if (!current) {
    return undefined
  }

  // Include every write planned in the current tool batch, before the first one executes.
  // Raw branch entries survive reload and retain arguments hidden by context excerpts.
  const entries = recent(ctx)
  const assistants = entries.filter(
    (entry) => entry.type === 'message' && entry.message.role === 'assistant',
  )
  const calls = assistants.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'assistant'
      ? entry.message.content.flatMap((part) =>
          part.type === 'toolCall'
            ? [{ id: part.id, edit: attempt(part.name, part.arguments, ctx.cwd) }]
            : [],
        )
      : [],
  )
  const edits = calls.flatMap((call) => (call.edit ? [call.edit] : []))

  if (!calls.some((call) => call.id === event.toolCallId)) {
    edits.push(current)
  }

  if (new Set(edits.map((edit) => edit.path)).size > documentBudget.files) {
    return 'Updating multiple documents belongs in one background document task.'
  }

  if (
    edits.length > documentBudget.calls ||
    edits.reduce((size, edit) => size + edit.bytes, 0) > documentBudget.bytes ||
    assistants.length > documentBudget.steps
  ) {
    return 'This exceeds the quick-edit budget: one file, two calls, 2 KB and four model steps.'
  }

  return undefined
}

export function registerDocumentRouting(pi: ExtensionAPI): void {
  pi.on('tool_call', (event, ctx) => {
    const reason = documentRoute(event, ctx)

    if (reason) {
      return {
        block: true,
        reason:
          reason +
          ' Call delegate_task with kind documents, all remaining paths and decisions/context. ' +
          'Then answer the user or continue discussion immediately. No permission, checkpoint ' +
          'or user request to delegate is needed. Do not use a shell bypass.',
      }
    }

    return undefined
  })
}
