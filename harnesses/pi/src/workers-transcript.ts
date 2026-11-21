import type { ConversationEntry } from './worker-live.ts'

/**
 * Reading model for worker conversations. Raw trace entries become speaker turns whose tool
 * calls are paired with their outcomes, so the viewer can show what happened instead of JSON.
 */

export type Tone = 'ok' | 'fail' | 'blocked' | 'info'
export type Outcome = { tone: Tone; summary: string; detail: string[]; hidden: number }
export type Action = {
  verb: string
  target: string
  signature: string
  executed: boolean
  outcome?: Outcome
  note?: { tone: Tone; lines: string[] }
}
export type Block =
  | { kind: 'prose'; text: string }
  | { kind: 'action'; action: Action }
  | { kind: 'result'; outcome: Outcome }
export type Speaker = 'worker' | 'guidance' | 'assignment' | 'harness' | 'summary'
export type Turn = { speaker: Speaker; at: string; label?: string; blocks: Block[]; tone?: Tone }

const verbs: Record<string, string> = {
  project_edit: 'Edit',
  project_write: 'Write',
  project_read: 'Read',
  project_search: 'Search',
  project_delete: 'Delete',
  project_format: 'Format',
  original_read: 'Original',
  document_check: 'Check',
  run_command: 'Run',
  verify_loop: 'Verify',
  read_reference: 'Reference',
  report_progress: 'Progress',
  submit_result: 'Submit',
  bash: 'Run',
  edit: 'Edit',
  write: 'Write',
  read: 'Read',
  grep: 'Search',
  find: 'Find',
  ls: 'List',
}
const failureWords = [
  'outside (this|the) worker',
  'not allowed',
  'permission denied',
  'denied',
  'refused',
  'failed',
  'cannot',
  'could not',
  'unable to',
  'not found',
  'invalid',
  'already submitted',
  'exceeds',
  'no such file',
  'enoent',
  'eacces',
]
const failure = new RegExp(`^(error\\b|unknown or invalid|.*\\b(${failureWords.join('|')}))`, 'i')

function firstLine(value: string, limit = 200): string {
  const line = value.trim().split('\n')[0] ?? ''
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Shell wrappers read better as the script they run. */
export function commandText(argv: unknown): string {
  if (typeof argv === 'string') {
    return firstLine(argv)
  }

  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string')) {
    return ''
  }

  const shell = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh$/.test(argv[0] ?? '')

  if (shell && argv.length === 3 && /^-[a-z]*c$/.test(argv[1]!)) {
    return firstLine(argv[2]!)
  }

  return firstLine(argv.map(quote).join(' '))
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function callLine(line: string): { name: string; args?: Record<string, unknown> } | undefined {
  const call = /^([\w.-]+) (\{.*)$/.exec(line)

  if (!call) {
    return undefined
  }

  const name = call[1]!.replace(/^mcp__[\w-]+?__/, '')
  const args = parseObject(call[2]!)

  // Prose such as "Note {x}" is not a call; partial streamed input still names a known tool.
  if (!args && !verbs[name] && !/^mcp__|_/.test(call[1]!)) {
    return undefined
  }

  return { name, args }
}

function targetOf(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '(input still streaming)'
  }

  const text = (value: unknown) => (typeof value === 'string' ? firstLine(value) : '')
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : ''

  if (name === 'verify_loop') {
    return text(args.mode) + ' ' + commandText(args.argv)
  }

  if (name === 'run_command' || args.argv !== undefined) {
    return commandText(args.argv)
  }

  if (name === 'submit_result') {
    return text(args.verdict ?? args.action) || 'result'
  }

  if (name === 'project_search') {
    const scope = text(args.pathPrefix)
    return (args.query ? `"${text(args.query)}"` : 'files') + (scope ? ` in ${scope}` : '')
  }

  const path = text(args.path ?? args.file_path) || list(args.paths)
  const extra = Array.isArray(args.additionalEdits) ? `  +${args.additionalEdits.length} edits` : ''
  const range = typeof args.startLine === 'number' && path ? `:${args.startLine}` : ''

  return (
    path + range + extra ||
    text(args.command) ||
    text(args.query ?? args.pattern) ||
    text(args.name) ||
    text(args.summary)
  )
}

function humanize(name: string): string {
  const words = name.replaceAll(/[_.-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function submitNote(args: Record<string, unknown> | undefined): Action['note'] {
  if (!args) {
    return undefined
  }

  const verdict = args.verdict ?? args.action
  const lines: string[] = []

  if (typeof args.summary === 'string') {
    lines.push(...args.summary.trim().split('\n').slice(0, 3))
  }

  const findings = Array.isArray(args.findings) ? args.findings : []
  const required = findings.filter((item) => item?.severity === 'required').length

  if (required) {
    lines.push(`${required} required finding${required === 1 ? '' : 's'}`)
  }

  for (const action of Array.isArray(args.hostActions) ? args.hostActions : []) {
    lines.push(`Needs host: ${action?.capability ?? 'action'} — ${firstLine(action?.reason ?? '')}`)
  }

  const tone: Tone =
    verdict === 'blocked' ? 'blocked' : verdict === 'pass' || verdict === 'stop' ? 'ok' : 'info'
  return lines.length || tone === 'blocked' ? { tone, lines } : undefined
}

function tail(output: string, count: number): { detail: string[]; hidden: number } {
  const lines = output.replace(/\s+$/, '').split('\n')

  if (!output.trim()) {
    return { detail: [], hidden: 0 }
  }

  return { detail: lines.slice(-count), hidden: Math.max(0, lines.length - count) }
}

function seconds(ms: unknown): string {
  if (typeof ms !== 'number') {
    return ''
  }

  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function commandOutcome(result: Record<string, unknown>): Outcome {
  const output = typeof result.output === 'string' ? result.output : ''
  const time = seconds(result.durationMs)
  const code = result.exitCode
  let tone: Tone = 'fail'
  let summary: string

  if (result.timedOut) {
    summary = `timed out${time ? ` after ${time}` : ''}`
  } else if (result.aborted) {
    tone = 'blocked'
    summary = 'cancelled'
  } else if (code === 0) {
    tone = 'ok'
    summary = 'exit 0'
  } else {
    summary = typeof code === 'number' ? `exit ${code}` : 'terminated without exit code'
  }

  const shown = tail(output, tone === 'ok' ? 3 : 8)

  if (result.truncated) {
    shown.detail.push('(output truncated by the sandbox)')
  }

  return {
    tone,
    summary: summary + (time && !result.timedOut ? `  ${time}` : ''),
    ...shown,
  }
}

function lineSpan(content: string): string {
  const lines = content.replace(/\n$/, '').split('\n')
  const first = /^(\d+): /.exec(lines[0] ?? '')?.[1]
  const last = /^(\d+): /.exec(lines.at(-1) ?? '')?.[1]
  const count = `${lines.length} line${lines.length === 1 ? '' : 's'}`
  return first && last && first !== last ? `${count} (${first}–${last})` : count
}

function objectOutcome(result: Record<string, unknown>): Outcome {
  const done = (summary: string, tone: Tone = 'ok'): Outcome => ({
    tone,
    summary,
    detail: [],
    hidden: 0,
  })

  if ('exitCode' in result && ('argv' in result || 'output' in result)) {
    return commandOutcome(result)
  }

  if (typeof result.error === 'string') {
    return done(firstLine(result.error), 'fail')
  }

  if (typeof result.edited === 'string') {
    return done('saved')
  }

  if (typeof result.written === 'string') {
    return done('written')
  }

  if (typeof result.deleted === 'string') {
    return done('deleted')
  }

  if (Array.isArray(result.formatted)) {
    return done(
      `formatted ${result.formatted.length} file${result.formatted.length === 1 ? '' : 's'}`,
    )
  }

  if (result.submitted === true) {
    return done('submitted')
  }

  if (result.recorded === true) {
    return done('noted')
  }

  if (typeof result.content === 'string') {
    return done(lineSpan(result.content))
  }

  if (Array.isArray(result.matches)) {
    const count = result.matches.length
    const more = typeof result.nextAfterPath === 'string' ? '+' : ''
    return done(count ? `${count}${more} match${count === 1 ? '' : 'es'}` : 'no matches')
  }

  if (
    typeof result.status === 'string' &&
    typeof result.completed === 'number' &&
    typeof result.requested === 'number' &&
    typeof result.snapshot === 'string'
  ) {
    const tone: Tone =
      result.status === 'passed' ? 'ok' : result.status === 'failed' ? 'fail' : 'blocked'
    const seed = typeof result.seed === 'number' ? ' at seed ' + result.seed : ''
    const reason = typeof result.reason === 'string' ? ' · ' + firstLine(result.reason) : ''
    return done(`${result.completed}/${result.requested} · ${result.status}${seed}${reason}`, tone)
  }

  if (typeof result.status === 'string') {
    const status = result.status
    const tone: Tone = /fail|error|reject/i.test(status)
      ? 'fail'
      : /block|attention/i.test(status)
        ? 'blocked'
        : 'ok'
    const message = [result.summary, result.message, result.reason].find(
      (value) => typeof value === 'string',
    )
    return done(status.replaceAll('_', ' ') + (message ? `: ${firstLine(message, 160)}` : ''), tone)
  }

  const pairs = Object.entries(result)
    .filter(
      ([key, value]) => key !== 'call' && ['string', 'number', 'boolean'].includes(typeof value),
    )
    .slice(0, 3)
    .map(([key, value]) => `${key} ${firstLine(String(value), 60)}`)
  return done(pairs.join('  ') || 'done')
}

/** Summarises one tool result. Plain-text errors from older traces are recognised as failures. */
export function outcomeOf(text: string, verb = ''): Outcome {
  const result = parseObject(text.trim())

  if (result) {
    return objectOutcome(result)
  }

  const body = text.trim()

  if (!body) {
    return { tone: 'ok', summary: 'done', detail: [], hidden: 0 }
  }

  if (/^New (?:user )?guidance arrived/.test(body)) {
    return { tone: 'blocked', summary: 'paused for new guidance', detail: [], hidden: 0 }
  }

  const exit = /exited with code (\d+)/i.exec(body)
  const lines = body.split('\n')

  if (exit && exit[1] !== '0') {
    return { tone: 'fail', summary: `exit ${exit[1]}`, ...tail(body.replace(exit[0], ''), 8) }
  }

  if (lines.length <= 3 && body.length < 600 && failure.test(lines[0]!)) {
    return { tone: 'fail', summary: firstLine(body), ...tail(lines.slice(1).join('\n'), 2) }
  }

  if (verb === 'Read' || verb === 'Reference' || verb === 'Original' || lines.length > 4) {
    return { tone: 'ok', summary: lineSpan(body), detail: [], hidden: 0 }
  }

  return { tone: 'ok', summary: firstLine(body), detail: lines.slice(1, 4), hidden: 0 }
}

type Guidance = { text: string; label?: string }

function guidanceOf(text: string): Guidance | undefined {
  const value = parseObject(text)

  if (typeof value?.hostEvidence === 'string') {
    return { text: value.hostEvidence, label: 'Host observation' }
  }

  return typeof value?.userGuidance === 'string' ? { text: value.userGuidance } : undefined
}

/** Groups entries into turns. A worker turn starts with prose and owns the actions that follow. */
export function transcriptTurns(entries: ConversationEntry[]): Turn[] {
  const turns: Turn[] = []
  let worker: Turn | undefined

  const workerTurn = (at: string, prose: boolean): Turn => {
    const last = turns.at(-1)
    const fresh =
      last !== worker || !worker || (prose && worker.blocks.some((block) => block.kind !== 'prose'))

    if (fresh) {
      worker = { speaker: 'worker', at, blocks: [] }
      turns.push(worker)
    }

    return worker!
  }
  const pending: Action[] = []
  let ambiguous = false
  const attach = (at: string, text: string) => {

    // Older conversation entries have no call IDs. Concurrent results can arrive out of order.
    ambiguous ||= pending.length > 1
    const next = pending.shift()
    const action = ambiguous ? undefined : next

    if (!pending.length) {
      ambiguous = false
    }

    const outcome = outcomeOf(text, action?.verb)

    if (action) {
      action.outcome = outcome
    } else {
      workerTurn(at, false).blocks.push({ kind: 'result', outcome })
    }
  }

  for (const entry of entries) {
    const text = entry.text

    if (entry.role === 'assistant' || entry.role === 'tool') {
      const prose: string[] = []
      const flush = () => {
        if (prose.join('').trim()) {
          workerTurn(entry.at, true).blocks.push({ kind: 'prose', text: prose.join('\n').trim() })
        }

        prose.length = 0
      }

      for (const line of text.split('\n')) {
        const call = callLine(line)

        if (!call) {
          prose.push(line)
          continue
        }

        flush()
        const signature = call.name + ' ' + JSON.stringify(call.args ?? null)

        // Pi records both the model's call and its execution start; show the call once.
        if (entry.role === 'tool') {
          const announced = worker?.blocks.find(
            (block) =>
              block.kind === 'action' &&
              !block.action.executed &&
              block.action.signature === signature,
          )

          if (announced?.kind === 'action') {
            announced.action.executed = true
            continue
          }
        }

        const verb = verbs[call.name] ?? humanize(call.name)
        const action: Action = {
          verb,
          target: targetOf(call.name, call.args),
          signature,
          executed: entry.role === 'tool',
          note: call.name === 'submit_result' ? submitNote(call.args) : undefined,
        }
        pending.push(action)
        workerTurn(entry.at, false).blocks.push({ kind: 'action', action })
      }

      flush()
      continue
    }

    const object = parseObject(text.trim())

    const userMessage = entry.role === 'user' && guidanceOf(text)

    if (userMessage) {
      turns.push({
        speaker: 'guidance',
        label: userMessage.label,
        at: entry.at,
        blocks: [{ kind: 'prose', text: userMessage.text }],
      })
      continue
    }

    if (
      entry.role === 'user' &&
      typeof object?.taskControlRevision === 'number' &&
      typeof object.taskUpdate === 'string'
    ) {
      turns.push({
        speaker: 'harness',
        at: entry.at,
        label: 'Coordinator update',
        blocks: [{ kind: 'prose', text: object.taskUpdate }],
      })
      continue
    }

    if (
      entry.role === 'user' &&
      object &&
      ('assignment' in object || ('taskScope' in object && typeof object.task === 'string'))
    ) {
      const assigned = object.assignment ?? object.task
      const task = typeof assigned === 'string' ? assigned : ''
      const title = parseObject(task)?.task ?? task
      turns.push({
        speaker: 'assignment',
        at: entry.at,
        blocks: [{ kind: 'prose', text: firstLine(String(title), 300) || 'Assignment received.' }],
      })
      continue
    }

    // Older Claude traces stored tool results, including rejected calls, under the user role.
    const toolShaped = object && ('call' in object || 'edited' in object || 'written' in object)

    if (
      entry.role === 'toolResult' ||
      (entry.role === 'user' && (toolShaped || pending.length > 0))
    ) {
      const lines = text.split('\n')
      const guidance = lines.map(guidanceOf)
      const remainder = lines.filter((_line, index) => !guidance[index]).join('\n')
      attach(entry.at, remainder)

      for (const item of guidance) {
        if (item) {
          turns.push({
            speaker: 'guidance',
            label: item.label,
            at: entry.at,
            blocks: [{ kind: 'prose', text: item.text }],
          })
        }
      }

      continue
    }

    turns.push({
      speaker: 'harness',
      at: entry.at,
      label: entry.role === 'user' ? 'Harness' : humanize(entry.role),
      blocks: [{ kind: 'prose', text }],
    })
  }

  return turns
}

/** The exact trace view behind the r toggle. */
export function rawEntry(entry: ConversationEntry): string {
  return entry.role + ' · ' + entry.at.slice(11, 19) + '\n' + entry.text
}
