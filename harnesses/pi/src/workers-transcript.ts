import type { ConversationEntry } from './worker-live.ts'

function toolLine(line: string): string {
  const call = /^([\w.-]+) (\{.*)$/.exec(line)

  if (!call) {
    return line
  }

  const name = call[1]!.replace(/^mcp__piworker__/, '')

  try {
    const args = JSON.parse(call[2]!)
    const target = args.path ?? args.file_path ?? args.command ?? args.query
    const label: Record<string, string> = {
      project_edit: 'Edit',
      project_write: 'Write',
      project_read: 'Read',
      project_search: 'Search',
      bash: 'Run',
      edit: 'Edit',
      write: 'Write',
      read: 'Read',
    }
    return (
      '  › ' +
      (label[name] ?? name) +
      (typeof target === 'string' ? '  ' + target.split('\n')[0]!.slice(0, 160) : '')
    )
  } catch {
    return '  › ' + name + '  (partial tool input)'
  }
}

export function transcriptEntry(entry: ConversationEntry, raw: boolean): string {
  let body = entry.text
  let speaker = entry.role

  if (!raw) {
    if (speaker === 'assistant' || speaker === 'tool') {
      body = body.split('\n').map(toolLine).join('\n')
      speaker = speaker === 'assistant' ? 'Worker' : 'Tool'
    } else if (speaker === 'toolResult' || (speaker === 'user' && body.startsWith('{'))) {
      try {
        const result = JSON.parse(body)
        const path = result?.edited ?? result?.written

        if (typeof path === 'string') {
          body = 'Saved ' + path
          speaker = 'Tool result'
        } else if (speaker === 'toolResult' || typeof result?.call === 'string') {
          speaker = 'Tool result'
          body = JSON.stringify(result, null, 2)
        }
      } catch {
        // Plain-text and partial results retain their original message.
      }
    }

    if (speaker === 'toolResult' || speaker === 'Tool result') {
      const lines = body.split('\n')

      if (lines.length > 4 || body.length > 360) {
        body = lines.slice(0, 4).join('\n').slice(0, 360) + ' …  [r for raw]'
      }
    }
  }

  return speaker + ' · ' + entry.at.slice(11, 19) + '\n' + body
}
