import type { ExtensionAPI, Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import {
  MouseRegion,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import { ShellActivity, type ShellCall } from './shell-activity.ts'
import { inspectionRenderers } from './inspection-render.ts'
import { compactTool } from './tool-activity.ts'
import { describeShell } from './shell-outcome.ts'

function commandFrom(args: unknown) {
  return args && typeof args === 'object' && 'command' in args && typeof args.command === 'string'
    ? args.command
    : ''
}

function cleanLine(value: string) {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/\p{Cf}/gu, '')
}

const empty: Component = { render: () => [], invalidate() {} }

function highlights(calls: ShellCall[]) {
  const outcomes = new Map<string, NonNullable<ShellCall['outcome']>>()

  for (const { outcome } of calls) {
    if (outcome && (outcome.key || outcome.kind !== 'success')) {
      outcomes.set(outcome.kind + (outcome.key ?? outcome.text), outcome)
    }
  }

  return [...outcomes.values()]
}

function status(calls: ShellCall[]) {
  const running = calls.find((call) => !call.outcome)
  const failed = calls.filter((call) => call.outcome?.kind === 'error').length
  const count = calls.length + (calls.length === 1 ? ' call' : ' calls')
  const incomplete = calls.some((call) => call.outcome?.key === 'missing-result')
  const progress = running
    ? 'Running · ' + cleanLine(running.purpose)
    : incomplete
      ? 'Incomplete'
      : 'Done'
  return [
    count,
    ...(failed ? [failed + ' failed'] : []),
    ...(running || !failed ? [progress] : []),
  ].join(' · ')
}

function outputLines(value: string, width: number) {
  const text = stripTerminalSequences(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return text
    .split('\n')
    .flatMap((line) =>
      wrapTextWithAnsi(cleanLine(line.replaceAll('\t', '    ')), Math.max(1, width)),
    )
}

interface RowState {
  raw?: boolean
  output?: string
  content?: unknown
  cache?: { command: string; width: number; lines: string[] }
}

function rawLines(state: RowState, command: string, width: number, theme: Theme) {
  if (state.cache?.width === width && state.cache.command === command) {
    return state.cache.lines
  }

  const lines = [
    ...outputLines('$ ' + command, width).map((line) => theme.fg('accent', line)),
    ...outputLines(state.output ?? '', width),
  ]
  state.cache = { command, width, lines }
  return lines
}

export function shellRenderers(activity: ShellActivity): ToolRenderers {
  return {
    renderShell: 'self',
    renderCall(args, theme, ctx) {
      const command = commandFrom(args)
      const state: RowState = ctx.state
      let header = false
      let row = -1
      return new MouseRegion(
        {
          invalidate() {
            state.cache = undefined
          },
          render(width) {
            const item = activity.find(ctx.toolCallId)

            if (!item) {
              return [
                theme.fg(
                  'muted',
                  truncateToWidth(
                    command ? cleanLine(describeShell(command).purpose) : 'Shell',
                    width,
                  ),
                ),
              ]
            }

            const { group, call } = item
            const expanded = ctx.expanded || group.open
            header = group.calls[0] === call
            row = -1
            const lines: string[] = []
            const fit = (s: string) => truncateToWidth(s, width)

            if (header) {
              const arrow = expanded ? '▾ ' : '▸ '
              const label = status(group.calls)
              const titleWidth = Math.max(8, width - visibleWidth(label) - 5)
              const title = truncateToWidth(cleanLine(group.operation.title), titleWidth)
              const heading = theme.fg('accent', arrow + title) + ' · ' + label
              const hint = '  Click for calls · ' + ctx.keyText('app.tools.expand') + ' for raw'
              const inlineHint = !expanded && visibleWidth(heading + hint) <= width
              lines.push(fit(heading + (inlineHint ? theme.fg('dim', hint) : '')))

              if (!expanded) {
                for (const outcome of highlights(group.calls)) {
                  const color = outcome.kind === 'error' ? 'error' : 'muted'

                  for (const line of outputLines('  ' + outcome.text, width)) {
                    lines.push(theme.fg(color, line))
                  }
                }

                if (!inlineHint) {
                  lines.push(fit(theme.fg('dim', hint)))
                }
              }
            }

            if (expanded) {
              row = lines.length
              const raw = ctx.expanded || state.raw
              const marker = raw ? '  ▾ ' : '  ▸ '
              lines.push(fit(marker + cleanLine(call.purpose)))
              const outcome = call.outcome

              if (outcome) {
                const color = outcome.kind === 'error' ? 'error' : 'muted'

                for (const line of outputLines('    ' + outcome.text, width)) {
                  lines.push(theme.fg(color, line))
                }
              }

              if (raw) {
                lines.push(...rawLines(state, command, width, theme))
              }
            }

            return lines
          },
        },
        (event) => {
          if (event.type !== 'click' || event.button !== 'left') {
            return undefined
          }

          const item = activity.find(ctx.toolCallId)

          if (!item) {
            return undefined
          }

          if (header && (event.y === 0 || row === -1)) {
            item.group.open = !item.group.open
          } else if (row !== -1 && event.y === row) {
            state.raw = !state.raw
          }

          return { handled: true, render: true }
        },
      )
    },
    renderResult(result, _options, _theme, ctx) {
      const state: RowState = ctx.state

      if (state.content !== result.content) {
        state.content = result.content
        state.output = result.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
        state.cache = undefined
      }

      return empty
    },
  }
}

export function registerShellActivity(pi: ExtensionAPI) {
  const activity = new ShellActivity()
  const shell = shellRenderers(activity)
  pi.registerToolRenderer((name, next) => {
    if (name === 'bash') {
      return shell
    }

    if (name === 'codemode') {
      return inspectionRenderers
    }

    const base = next()
    return base?.renderShell === 'self' ? base : compactTool(name, base)
  })
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      activity.replay(ctx.sessionManager.getBranch())
    }
  })
  pi.on('session_tree', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      activity.replay(ctx.sessionManager.getBranch())
    }
  })
  pi.on('message_end', (event, ctx) => {
    if (ctx.mode === 'tui') {
      activity.observe(event.message)
    }
  })
}
