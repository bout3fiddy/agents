import type { CodemodeToolDetails, Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import {
  Container,
  MouseRegion,
  Text,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui'
import { terminalText } from './workers-render.ts'

type Call = CodemodeToolDetails['calls'][number]

function plain(value: string) {
  return terminalText(value).replace(/\p{Cf}/gu, '')
}

function oneLine(value: string) {
  return plain(value).trim().split('\n', 1)[0] ?? ''
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {

    // Display-only parse; malformed text renders unformatted.
    return undefined
  }
}

function target(call: Call) {
  const args = parse(call.args)

  if (!args || typeof args !== 'object') {
    return ''
  }

  for (const key of ['query', 'pattern', 'path', 'pathPrefix', 'name', 'id', 'runId', 'number']) {
    const value: unknown = Reflect.get(args, key)

    if (typeof value === 'string' || typeof value === 'number') {
      return oneLine(String(value))
    }
  }

  return ''
}

function title(call: Call) {
  return oneLine(call.name)
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

function failed(call: Call) {
  return call.status === 'error' || call.status === 'cancelled'
}

function row(line: string): Component {
  return { render: (width) => [truncateToWidth(line, width)], invalidate() {} }
}

function batchSize(calls: Call[]) {
  const reads =
    calls.length > 0 &&
    calls.every((call) => ['read', 'project_read', 'original_read'].includes(call.name))
  return calls.length + (reads ? ' file read' : ' call') + (calls.length === 1 ? '' : 's')
}

function callRow(call: Call, theme: Theme) {
  const icon = {
    ok: theme.fg('success', '✓'),
    error: theme.fg('error', '×'),
    running: theme.fg('warning', '…'),
    cancelled: theme.fg('warning', '⊘'),
  }[call.status]
  const subject = target(call)
  const label = theme.fg('muted', title(call))
  const error = oneLine(call.error ?? '')
  const reason = /\bENOENT\b/.test(error) ? 'File not found' : error
  const state = call.status === 'cancelled' ? ' · cancelled' : ''
  return row(
    '  ' +
      icon +
      ' ' +
      label +
      '  ' +
      subject +
      theme.fg('error', state + (reason ? ' · ' + reason : '')),
  )
}

/** Output ordering can differ from call ordering in concurrent scripts. Keep its own labels. */
function preview(item: string) {
  const value = parse(item)

  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
      return oneLine(value[0]) + '  ' + oneLine(value[1])
    }

    return value.length + (value.length === 1 ? ' item' : ' items')
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).slice(0, 5).map(oneLine).join(', ') || 'Empty object'
  }

  return oneLine(typeof value === 'string' ? value : item)
}

export const inspectionRenderers: ToolRenderers = {
  renderShell: 'self',
  renderCall(_args, theme, ctx) {
    if (!ctx.expanded) {
      ctx.state.inspectionRaw = false
    }

    return row(theme.fg('toolTitle', theme.bold((ctx.expanded ? '▾ ' : '▸ ') + 'Inspection')))
  },
  renderResult(result, options, theme, ctx) {
    const { expanded, isPartial } = options
    const view = new Container()
    const details = result.details as CodemodeToolDetails | undefined
    const calls = Array.isArray(details?.calls) ? details.calls : []
    const failures = calls.filter(failed)
    const blocks = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
    const header = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/
    const hasHeader = header.test(blocks[0] ?? '')
    const output = hasHeader ? blocks.slice(1) : blocks
    const error = ctx.isError || (hasHeader && blocks[0]!.startsWith('Script failed'))
    const running = isPartial || calls.some((call) => call.status === 'running')
    const status = error ? 'Failed' : running ? 'Running' : failures.length ? 'Incomplete' : 'Done'
    const color = error || failures.length ? 'error' : running ? 'warning' : 'success'
    const count = batchSize(calls)
    const cancelled = failures.filter((call) => call.status === 'cancelled').length
    const errors = failures.length - cancelled
    const issues =
      (errors ? ' · ' + errors + ' failed' : '') +
      (cancelled ? ' · ' + cancelled + ' cancelled' : '')
    const hint = expanded ? '' : '  ' + ctx.keyText('app.tools.expand') + ' for details'
    view.addChild(
      row('  ' + theme.fg(color, status) + ' · ' + count + issues + theme.fg('dim', hint)),
    )

    if (error) {
      const text = output.join('\n')
      const reason = /(?:^|\n)Script error:\n([^\n]+)/.exec(text)?.[1] ?? oneLine(text)
      view.addChild(row(theme.fg('error', '  ' + (oneLine(reason) || 'Script failed'))))
    }

    if (expanded) {
      for (const call of calls) {
        view.addChild(callRow(call, theme))
      }
    } else {
      const subjects = calls
        .filter((call) => !failed(call))
        .map(target)
        .filter(Boolean)

      if (subjects.length) {
        const more = subjects.length > 3 ? '  +' + (subjects.length - 3) : ''
        view.addChild(row(theme.fg('muted', '  ' + subjects.slice(0, 3).join(' · ') + more)))
      }

      for (const call of failures.slice(0, 2)) {
        view.addChild(callRow(call, theme))
      }

      return view
    }

    if (!running && !error && !ctx.state.inspectionRaw) {
      const items = output
        .flatMap((text) => text.split(/^==> text \d+\/\d+ <==\n/gm))
        .filter((text) => text.trim())
      const visible = items.slice(0, 3)

      if (visible.length) {
        const more =
          items.length > visible.length ? ' · ' + (items.length - visible.length) + ' more' : ''
        view.addChild(row(theme.fg('muted', '  Output preview' + more)))

        for (const item of visible) {
          view.addChild(row('    ' + preview(item.trim())))
        }
      }
    }

    const raw = Boolean(ctx.state.inspectionRaw)
    const toggle = (raw ? '▾ Hide' : '▸ Show') + ' raw script and output'
    view.addChild(
      new MouseRegion(row(theme.fg('accent', '  ' + toggle)), (event) => {
        if (event.type === 'click' && event.button === 'left') {
          ctx.state.inspectionRaw = !raw
          ctx.invalidate()
          return { handled: true }
        }

        return undefined
      }),
    )

    if (raw) {
      const code = ctx.args && typeof ctx.args === 'object' && 'code' in ctx.args && ctx.args.code
      const sections: [string, string][] = [
        ['Script', typeof code === 'string' ? code : ''],
        [
          'Calls',
          calls
            .map((call) =>
              [call.status, call.name, call.args, call.error].filter(Boolean).join(' '),
            )
            .join('\n'),
        ],
        ['Output', blocks.join('\n')],
      ]

      for (const [label, body] of sections) {
        if (body) {
          view.addChild(row(theme.fg('accent', label)))
          view.addChild(new Text(plain(body), 0, 0))
        }
      }
    }

    return view
  },
}
