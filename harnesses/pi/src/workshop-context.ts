import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent'

const archived = '[Archived tool payload; complete contents remain in the project session trace.]'
const fileTools = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'project_read',
  'project_search',
])

function excerpt(text: string, limit: number): string {
  if (text.length <= limit || text.startsWith(archived)) {
    return text
  }

  const characters = Array.from(text)
  const head = characters.slice(0, Math.floor(limit * 0.7)).join('')
  const tail = characters.slice(-Math.floor(limit * 0.2)).join('')
  return `${archived}\n${head}\n[… excerpt …]\n${tail}`
}

function currentReads(entries: ProjectedSessionEntry[]): Set<string> {
  const reads = new Map<string, Set<string>>()
  const calls = new Map<string, { name: string; path: string }>()

  for (const entry of entries) {
    for (const message of entry.messages) {
      if (message.role === 'user') {
        reads.clear()
      }

      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'toolCall' && typeof part.arguments?.path === 'string') {
            calls.set(part.id, { name: part.name, path: part.arguments.path })
          }
        }
      }

      if (message.role === 'toolResult' && !message.isError) {
        const call = calls.get(message.toolCallId)

        if (call && ['read', 'project_read'].includes(call.name)) {
          const ids = reads.get(call.path) ?? new Set<string>()
          ids.add(message.toolCallId)
          reads.set(call.path, ids)
        } else if (call && ['write', 'edit'].includes(call.name)) {
          reads.delete(call.path)
        }
      }
    }
  }

  return new Set([...reads.values()].flatMap((ids) => [...ids]))
}

export function workshopContextEdits(entries: ProjectedSessionEntry[]): ContextEditEntryDraft[] {
  const assistants = entries.filter((entry) =>
    entry.messages.some((message) => message.role === 'assistant'),
  )
  const cutoff = assistants.at(-4)?.sourceEntry.id

  if (!cutoff) {
    return []
  }

  const edits: ContextEditEntryDraft[] = []
  const protectedReads = currentReads(entries)
  const lastUser = entries.findLastIndex((entry) =>
    entry.messages.some((message) => message.role === 'user'),
  )

  for (const [index, entry] of entries.entries()) {
    if (entry.sourceEntry.id === cutoff) {
      break
    }

    const message = entry.messages[0]

    if (!message || entry.messages.length !== 1) {
      continue
    }

    if (
      message.role === 'toolResult' &&
      fileTools.has(message.toolName) &&
      !message.isError &&
      !protectedReads.has(message.toolCallId) &&
      !(message.toolName === 'bash' && index > lastUser)
    ) {
      const content = message.content.map((part) =>
        part.type === 'text' ? { ...part, text: excerpt(part.text, 4000) } : part,
      )

      if (JSON.stringify(content) !== JSON.stringify(message.content)) {
        edits.push({
          type: 'context_edit',
          targetId: entry.sourceEntry.id,
          replacement: { content },
        })
      }
    }

    if (message.role === 'assistant') {
      const content = message.content.map((part) => {
        if (part.type !== 'toolCall' || !['write', 'edit', 'bash'].includes(part.name)) {
          return part
        }

        const args = { ...part.arguments }

        for (const field of ['content', 'command', 'oldText', 'newText']) {
          if (typeof args[field] === 'string') {
            args[field] = excerpt(args[field], 2000)
          }
        }

        if (Array.isArray(args.edits)) {
          args.edits = args.edits.map((edit) => {
            if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
              return edit
            }

            const updated = { ...edit }

            for (const key of ['oldText', 'newText']) {
              if (typeof updated[key] === 'string') {
                updated[key] = excerpt(updated[key], 1000)
              }
            }

            return updated
          })
        }

        return { ...part, arguments: args }
      })

      if (JSON.stringify(content) !== JSON.stringify(message.content)) {
        edits.push({
          type: 'context_edit',
          targetId: entry.sourceEntry.id,
          replacement: { content },
        })
      }
    }
  }

  return edits
}

export function registerWorkshopContext(pi: ExtensionAPI): void {
  pi.on('turn_end', (event) => {
    const edits = workshopContextEdits(event.context.contextEntries)
    return edits.length ? { entries: [...event.entries, ...edits] } : undefined
  })
}
