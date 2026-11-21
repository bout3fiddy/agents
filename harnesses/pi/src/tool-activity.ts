import type { ToolRenderers, Theme } from '@earendil-works/pi-coding-agent'
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

function detail(text: string) {
  return new Text(stripTerminalSequences(text).split('\n').map(line).join('\n'), 0, 0)
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
          detail(name + ' ' + JSON.stringify(args ?? {}))
        )
      }

      if (name === 'host_work' && !ctx.isError) {
        return hidden
      }

      const target = field(args, 'path') || field(args, 'title')
      return row('▸ ' + title + (target ? ' · ' + target : ''), theme, ctx.isError)
    },
    renderResult(result, options, theme, ctx) {
      if (options.expanded) {
        return (
          base?.renderResult?.(result, options, theme, expandedContext(ctx)) ??
          detail(
            result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
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

      if (name === 'host_work' && !options.isPartial) {
        const state = field(ctx.args, 'state')

        if (
          (state === 'paused' || state === 'waiting') &&
          !(ctx.args && typeof ctx.args === 'object' && 'retry' in ctx.args)
        ) {
          return row(state + ' · ' + field(ctx.args, 'detail'), theme)
        }
      }

      return hidden
    },
  }
}
