import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

// Limit work per stream event independently of the size of the retained thinking block.
function caption(thinking: string): string {
  const tail = stripTerminalSequences(thinking.slice(-512)).trimEnd()
  const line = tail.slice(tail.lastIndexOf('\n') + 1)
  return line
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, '$1')
}

export function registerActivityCaption(pi: ExtensionAPI): void {
  let current = ''

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      ctx.ui.setHiddenThinkingLabel('')
    }
  })
  pi.on('message_update', ({ message, assistantMessageEvent: update }, ctx) => {
    if (
      ctx.mode !== 'tui' ||
      message.role !== 'assistant' ||
      (update.type !== 'thinking_delta' && update.type !== 'thinking_end')
    ) {
      return
    }

    const block = message.content[update.contentIndex]
    const next = block?.type === 'thinking' && !block.redacted ? caption(block.thinking) : ''

    if (next && next !== current) {
      current = next
      ctx.ui.setWorkingMessage(next)
    }
  })
  pi.on('agent_end', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      current = ''
      ctx.ui.setWorkingMessage()
    }
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      current = ''
      ctx.ui.setWorkingMessage()
      ctx.ui.setHiddenThinkingLabel()
    }
  })
}
