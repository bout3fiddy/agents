import { highlightCode, type ToolRenderers, type Theme } from '@earendil-works/pi-coding-agent'
import {
  Text,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui'

class CompactRow implements Component {
  constructor(readonly render: (width: number) => string[]) {}
  invalidate() {}
}

const hidden = new CompactRow(() => [])

// Pi's built-in renderers reuse their own Text, diff, or preview components on updates.
function expandedContext<T extends { lastComponent: Component | undefined }>(ctx: T) {
  return ctx.lastComponent instanceof CompactRow ? { ...ctx, lastComponent: undefined } : ctx
}

function line(value: string) {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/\p{Cf}/gu, '')
}

function row(text: string, theme: Theme, error = false): Component {
  return new CompactRow((width) => [
    theme.fg(error ? 'error' : 'muted', truncateToWidth(line(text), width)),
  ])
}

function clean(text: string) {
  return stripTerminalSequences(text).split('\n').map(line).join('\n')
}

function jsonDetail(text: string) {
  const formatted = clean(text)
  return formatted.length <= 16000 ? highlightCode(formatted, 'json').join('\n') : formatted
}

// Preserve the original JSON tokens, including numeric precision, escape sequences and key order.
function prettyBlock(text: string) {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return clean(text)
  }

  try {
    JSON.parse(trimmed)
  } catch {

    // Display-only parse; malformed payloads render as cleaned text.
    return clean(text)
  }

  const pieces: string[] = []
  let depth = 0
  let previous = ''

  for (const [token] of trimmed.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const closing = token === '}' || token === ']'
    const afterOpen = previous === '{' || previous === '['

    if (closing) {
      depth--
    }

    if ((afterOpen && !closing) || (closing && !afterOpen) || previous === ',') {
      pieces.push('\n', '  '.repeat(Math.min(depth, 32)))
    } else if (previous === ':') {
      pieces.push(' ')
    }

    pieces.push(token)

    if (token === '{' || token === '[') {
      depth++
    }

    previous = token
  }

  return jsonDetail(pieces.join(''))
}

function section(label: string, blocks: string[], theme: Theme) {
  return new Text([theme.fg('toolTitle', theme.bold(label)), ...blocks].join('\n'), 0, 0)
}

function field(args: unknown, key: string) {
  if (args && typeof args === 'object') {
    const value = (args as Record<string, unknown>)[key]

    if (typeof value === 'string') {
      return value
    }
  }

  return ''
}

export function compactTool(name: string, base?: ToolRenderers): ToolRenderers {
  const title = name.replaceAll('_', ' ')
  return {
    renderShell: 'self',
    renderCall(args, theme, ctx) {
      if (ctx.expanded) {
        return (
          base?.renderCall?.(args, theme, expandedContext(ctx)) ??
          section(title + ' · arguments', [jsonDetail(JSON.stringify(args ?? {}, null, 2))], theme)
        )
      }

      const target = name.startsWith('job_')
        ? [field(args, 'id'), field(args, 'title')].filter(Boolean).join(' · ')
        : field(args, 'path') || field(args, 'title')
      return row('▸ ' + title + (target ? ' · ' + target : ''), theme, ctx.isError)
    },
    renderResult(result, options, theme, ctx) {
      if (options.expanded) {
        return (
          base?.renderResult?.(result, options, theme, expandedContext(ctx)) ??
          section(
            ctx.isError ? 'Error' : 'Result',
            result.content.flatMap((part) =>
              part.type === 'text' ? [prettyBlock(part.text)] : [],
            ),
            theme,
          )
        )
      }

      if (ctx.isError) {
        const output = result.content.find((part) => part.type === 'text')?.text.trim()
        const firstLine = output?.split('\n', 1)[0]
        return row(
          firstLine && !/^[{[]/.test(firstLine)
            ? '  Failed · ' + firstLine
            : '  Failed · expand for details',
          theme,
          true,
        )
      }

      return hidden
    },
  }
}
