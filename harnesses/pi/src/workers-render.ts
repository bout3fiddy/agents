import {
  Markdown,
  replaceControlCharacters,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'
import type { ConversationEntry } from './worker-live.ts'
import {
  transcriptTurns,
  type Action,
  type Block,
  type Outcome,
  type Tone,
  type Turn,
} from './workers-transcript.ts'

/** Untrusted worker and tool text must not inject terminal controls into the viewer. */
export function terminalText(value: string): string {
  return stripTerminalSequences(value)
    .replaceAll('\t', '  ')
    .split('\n')
    .map(replaceControlCharacters)
    .join('\n')
}

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)

/** OSC sequences, including OSC 8 hyperlinks, never reach the terminal from rendered Markdown. */
function withoutOsc(line: string): string {
  let result = ''
  let index = 0

  for (;;) {
    const start = line.indexOf(escape + ']', index)

    if (start < 0) {
      return result + line.slice(index)
    }

    result += line.slice(index, start)
    const bellEnd = line.indexOf(bell, start)
    const stringEnd = line.indexOf(escape + '\\', start)
    const ends = [bellEnd < 0 ? Infinity : bellEnd + 1, stringEnd < 0 ? Infinity : stringEnd + 2]
    const end = Math.min(...ends)

    // An unterminated sequence would swallow the rest of the line in the terminal as well.
    if (end === Infinity) {
      return result
    }

    index = end
  }
}

const inlineLink = /(!?)\[([^[\]\n]*)\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

/** Shows every link destination as text; reference definitions cannot hide a target. */
export function visibleLinks(markdown: string): string {
  let fence = ''
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

      if (marker && (!fence || marker.startsWith(fence))) {
        fence = fence ? '' : marker
        return line
      }

      if (fence) {
        return line
      }

      const definition = /^( {0,3})(\[[^\]\n]+\]:.*)$/.exec(line)

      // A reference definition would vanish and silently retarget links, so it stays literal text.
      if (definition) {
        const ticks = '`'.repeat(
          Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length)) + 1,
        )
        return `${definition[1]}${ticks} ${definition[2]!.trim()} ${ticks}`
      }

      return line
        .split(/(`+[^`\n]*?`+)/)
        .map((part, index) => {
          if (index % 2) {
            return part
          }

          return part.replace(inlineLink, (_match, image: string, text: string, url: string) => {
            const label = text.trim()

            if (image) {
              return `${label || 'image'} (image: ${url})`
            }

            return !label || label === url ? url : `${label} (${url})`
          })
        })
        .join('')
    })
    .join('\n')
}

type Paint = (text: string) => string

const glyphs: Record<Tone, [string, ThemeColor]> = {
  ok: ['✓', 'success'],
  fail: ['✗', 'error'],
  blocked: ['▲', 'warning'],
  info: ['•', 'muted'],
}

export type ConversationView = {

  /** Display name of the worker role, used for its turn dividers. */
  name: string
  active: boolean
  partial?: string
  partialAt?: string
  summary?: { status: string; text: string }
}

/** Renders worker turns as styled, width-bounded terminal lines. */
export class ConversationRenderer {
  private cache = new Map<string, string[]>()
  private readonly markdownTheme: MarkdownTheme

  constructor(private readonly theme: Theme) {
    const fg = (color: ThemeColor) => (text: string) => theme.fg(color, text)
    const style = (name: 'italic' | 'underline' | 'strikethrough'): Paint =>
      typeof theme[name] === 'function' ? (text) => theme[name](text) : (text) => text
    this.markdownTheme = {
      heading: (text) => theme.bold(theme.fg('mdHeading', text)),
      link: fg('mdLink'),
      linkUrl: fg('mdLinkUrl'),
      code: fg('mdCode'),
      codeBlock: fg('mdCodeBlock'),
      codeBlockBorder: fg('mdCodeBlockBorder'),
      quote: fg('mdQuote'),
      quoteBorder: fg('mdQuoteBorder'),
      hr: fg('mdHr'),
      listBullet: fg('mdListBullet'),
      bold: (text) => theme.bold(text),
      italic: style('italic'),
      underline: style('underline'),
      strikethrough: style('strikethrough'),
    }
  }

  render(entries: ConversationEntry[], view: ConversationView, width: number): string[] {
    const all = view.partial
      ? [...entries, { at: view.partialAt ?? '', role: 'assistant', text: view.partial }]
      : entries
    const turns = transcriptTurns(all).map(cleanTurn)

    if (view.summary) {
      const { status, text } = view.summary
      const tone: Tone = /fail|error/.test(status)
        ? 'fail'
        : /attention|block/.test(status)
          ? 'blocked'
          : status === 'complete'
            ? 'ok'
            : 'info'
      turns.push({
        speaker: 'summary',
        at: '',
        label:
          status === 'needs_attention'
            ? 'Needs attention'
            : terminalText(status).replaceAll('_', ' '),
        tone,
        blocks: [{ kind: 'prose', text: terminalText(text) }],
      })
    }

    if (this.cache.size > 4000) {
      this.cache.clear()
    }

    const lines: string[] = []
    const lastAction = turns.at(-1)?.blocks.at(-1)

    for (const turn of turns) {
      if (lines.length) {
        lines.push('')
      }

      lines.push(...this.turn(turn, view, width, view.active ? lastAction : undefined))
    }

    return lines.map((line) => truncateToWidth(withoutOsc(line), width, '…'))
  }

  private divider(turn: Turn, view: ConversationView, width: number): string {
    const { theme } = this
    const [label, color]: [string, ThemeColor] =
      turn.speaker === 'worker'
        ? [view.name, 'accent']
        : turn.speaker === 'guidance'
          ? ['You', 'borderAccent']
          : turn.speaker === 'assignment'
            ? ['Assignment', 'muted']
            : turn.speaker === 'summary'
              ? [turn.label ?? 'Result', glyphs[turn.tone ?? 'info'][1]]
              : [turn.label ?? 'Harness', 'muted']
    const mark = turn.speaker === 'summary' ? glyphs[turn.tone ?? 'info'][0] + ' ' : ''
    const time = turn.at.slice(11, 19)
    const head = theme.fg(color, theme.bold(mark + label))
    const fill = width - visibleWidth(mark + label) - (time ? visibleWidth(time) + 1 : 0) - 1

    if (fill < 3) {
      return truncateToWidth(head + (time ? ' ' + theme.fg('dim', time) : ''), width)
    }

    return (
      head +
      ' ' +
      theme.fg('borderMuted', '─'.repeat(fill)) +
      (time ? ' ' + theme.fg('dim', time) : '')
    )
  }

  private markdown(text: string, width: number, color?: ThemeColor): string[] {
    const key = `${color ?? ''}\0${width}\0${text}`
    let lines = this.cache.get(key)

    if (!lines) {
      const style = color ? { color: (value: string) => this.theme.fg(color, value) } : undefined
      lines = new Markdown(visibleLinks(text), 0, 0, this.markdownTheme, style, {
        renderLatex: false,
      })
        .render(Math.max(1, width))
        .map((line) => withoutOsc(line).replace(/\s+$/, ''))

      while (lines.length && !lines.at(-1)) {
        lines.pop()
      }

      this.cache.set(key, lines)
    }

    return lines
  }

  private railed(lines: string[], rail: string, color: ThemeColor): string[] {
    return lines.map((line) => this.theme.fg(color, rail) + line)
  }

  private turn(turn: Turn, view: ConversationView, width: number, live?: Block): string[] {
    const lines = [this.divider(turn, view, width)]
    let previous: string | undefined

    for (const block of turn.blocks) {
      if (previous && (block.kind === 'prose' || previous === 'prose')) {
        lines.push('')
      }

      previous = block.kind

      if (block.kind === 'action') {
        lines.push(...this.action(block.action, width, block === live))
      } else if (block.kind === 'result') {
        lines.push(...this.outcomeRow('Result', '', block.outcome, width))
      } else if (turn.speaker === 'guidance') {
        lines.push(...this.railed(this.markdown(block.text, width - 2), '┃ ', 'borderAccent'))
      } else if (turn.speaker === 'summary' && turn.tone !== 'ok') {
        const [, color] = glyphs[turn.tone ?? 'info']
        lines.push(...this.railed(this.markdown(block.text, width - 2), '┃ ', color))
      } else if (turn.speaker === 'assignment' || turn.speaker === 'harness') {
        lines.push(...this.markdown(block.text, width, 'muted'))
      } else if (/^\W{0,4}(blocked|blocker)s?\b/im.test(block.text)) {
        lines.push(...this.railed(this.markdown(block.text, width - 2), '▌ ', 'warning'))
      } else {
        lines.push(...this.markdown(block.text, width))
      }
    }

    if (turn.speaker === 'assignment') {
      lines.push(this.theme.fg('dim', 'p shows the full prompt'))
    }

    return lines
  }

  private action(action: Action, width: number, live: boolean): string[] {
    const target =
      action.note?.tone === 'blocked' ? this.theme.fg('warning', action.target) : action.target
    const lines = this.outcomeRow(action.verb, target, action.outcome, width, live)

    if (action.note) {
      const [glyph, color] = glyphs[action.note.tone]

      for (const [index, note] of action.note.lines.entries()) {
        const rail = index ? '      ' : `    ${glyph} `
        const wrapped = wrapTextWithAnsi(note, Math.max(1, width - 6)).slice(0, 3)
        lines.push(
          ...wrapped.map(
            (part, row) =>
              this.theme.fg(color, row ? '      ' : rail) +
              (action.note!.tone === 'blocked' ? this.theme.fg('warning', part) : part),
          ),
        )
      }
    }

    return lines
  }

  private outcomeRow(
    verb: string,
    target: string,
    outcome: Outcome | undefined,
    width: number,
    live = false,
  ): string[] {
    const { theme } = this
    const pad = width < 40 ? 0 : 9
    const head =
      theme.fg('dim', '  › ') + theme.fg('muted', verb.padEnd(Math.max(pad, verb.length + 1)))
    const room = Math.max(1, width - visibleWidth(head))
    const [glyph, color] = outcome ? glyphs[outcome.tone] : ['…', 'dim' as ThemeColor]
    const result = outcome
      ? theme.fg(color, glyph + ' ' + outcome.summary)
      : live
        ? theme.fg('dim', '… running')
        : ''
    const together = target ? target + '   ' + result : result
    const lines: string[] = []

    if (visibleWidth(together) <= room) {
      lines.push(head + (target ? target + (result ? '   ' : '') : '') + result)
    } else {
      lines.push(head + clip(target, room))

      if (result) {
        lines.push(
          ...wrapTextWithAnsi(result, Math.max(1, width - 4))
            .slice(0, 3)
            .map((part) => '    ' + part),
        )
      }
    }

    if (!outcome) {
      return lines
    }

    const gutter = theme.fg('dim', '    │ ')
    const room2 = Math.max(1, width - 6)

    if (outcome.hidden) {
      lines.push(gutter + theme.fg('dim', `${outcome.hidden} earlier lines hidden, r shows raw`))
    }

    for (const detail of outcome.detail) {
      const paint = outcome.tone === 'ok' ? (text: string) => theme.fg('muted', text) : String
      lines.push(
        ...wrapTextWithAnsi(detail, room2)
          .slice(0, 3)
          .map((part) => gutter + paint(part)),
      )
    }

    return lines
  }
}

/** Paths keep their file name when clipped; other targets keep their beginning. */
function clip(text: string, width: number): string {
  const size = visibleWidth(text)

  if (size <= width) {
    return text
  }

  if (/^[^\s]*\/[^\s]*$/.test(stripTerminalSequences(text)) && width > 1) {
    return '…' + sliceByColumn(text, size - width + 1, width - 1)
  }

  return truncateToWidth(text, width, '…')
}

/** JSON-decoded values can carry escapes, so every displayed field is cleaned after parsing. */
function cleanTurn(turn: Turn): Turn {
  const outcome = (value: Outcome): Outcome => ({
    ...value,
    summary: terminalText(value.summary).replaceAll('\n', ' '),
    detail: value.detail.map((line) => terminalText(line).replaceAll('\n', ' ')),
  })
  return {
    ...turn,
    label: turn.label && terminalText(turn.label),
    blocks: turn.blocks.map((block): Block => {
      if (block.kind === 'prose') {
        return { kind: 'prose', text: terminalText(block.text) }
      }

      if (block.kind === 'result') {
        return { kind: 'result', outcome: outcome(block.outcome) }
      }

      const { action } = block
      return {
        kind: 'action',
        action: {
          ...action,
          verb: terminalText(action.verb).replaceAll('\n', ' '),
          target: terminalText(action.target).replaceAll('\n', ' '),
          outcome: action.outcome && outcome(action.outcome),
          note: action.note && {
            ...action.note,
            lines: action.note.lines.map((line) => terminalText(line).replaceAll('\n', ' ')),
          },
        },
      }
    }),
  }
}
