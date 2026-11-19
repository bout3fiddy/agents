import {
  Input,
  matchesKey,
  stripTerminalSequences,
  replaceControlCharacters,
  truncateToWidth,
  wrapTextWithAnsi,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { taskTitle, type WorkersCatalog, type WorkerRow } from './workers-data.ts'
import { workerTree } from './workers-tree.ts'
import type { ConversationEntry } from './worker-live.ts'

type Source = Pick<WorkersCatalog, 'list' | 'conversation' | 'send' | 'warnings'>
const names: Record<string, string> = {
  'task-coordinator': 'Coordinator',
  'branch-orchestrator': 'Branch coordinator',
  'task-worker': 'Worker',
  implementer: 'Implementer',
  reviewer: 'Review',
  'database-reviewer': 'Database review',
  performance: 'Performance',
}

export function terminalText(value: string): string {

  // Untrusted tool output must not inject terminal controls into the viewer.
  return stripTerminalSequences(value)
    .replaceAll('\t', '  ')
    .split('\n')
    .map(replaceControlCharacters)
    .join('\n')
}

function age(at: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

function status(row: WorkerRow): string {
  if (!row.active) {
    return row.taskStatus && row.legacy ? row.taskStatus : row.state.status
  }

  return `${row.state.tool ?? row.state.stage} · ${age(row.state.updatedAt)} ago`
}

/** Both the picker and the non-capturing panel observe existing processes only. */
export class WorkersView implements Focusable {
  private hasFocus = false
  readonly input = new Input({ prompt: 'Guidance › ' })
  rows: WorkerRow[] = []
  activeTab = true
  selectedId?: string
  conversationId?: string
  mode: 'chat' | 'details' | 'prompt' = 'chat'
  composing = false
  notice = ''
  private conversation: ConversationEntry[] = []
  private truncated = false
  private bytes = 131072
  private offset = 0
  private collapsed = new Set<string>()
  private lastBodyLines = 0
  private refreshPromise?: Promise<void>
  private sending = false
  private disposed = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly source: Source,
    private readonly theme: Theme,
    private readonly height: () => number,
    private readonly redraw: () => void,
    private readonly close: () => void,
    readonly panel = false,
    autoRefresh = true,
  ) {
    this.input.onSubmit = (text) => {
      void this.send(text)
    }
    this.input.onEscape = () => {
      this.composing = false
      this.redraw()
    }

    if (autoRefresh) {
      void this.refresh()
      this.timer = setInterval(() => {
        void this.refresh()
      }, 1000)
    }
  }

  get focused(): boolean {
    return this.hasFocus
  }
  set focused(value: boolean) {
    this.hasFocus = value
    this.input.focused = value && this.composing
  }

  invalidate(): void {
    this.input.invalidate()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
  }

  refresh(): Promise<void> {
    this.refreshPromise ??= this.load().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async load(): Promise<void> {
    if (this.disposed) {
      return
    }

    try {
      const rows = await this.source.list()

      if (this.disposed) {
        return
      }

      this.rows = rows
      const nodes = this.visibleNodes()

      if (!nodes.some((node) => node.row.id === this.selectedId)) {
        this.selectedId = nodes[0]?.row.id
      }

      const row = rows.find((item) => item.id === this.conversationId)

      if (row) {
        const conversation = await this.source.conversation(row, this.bytes)

        if (this.disposed) {
          return
        }

        this.conversation = conversation.entries
        this.truncated = conversation.truncated
      }

      if (this.source.warnings.length) {
        this.notice = `Some worker records are unavailable: ${this.source.warnings.join('; ')}`
      }
    } catch (error) {
      this.notice = `Refresh failed; showing last observation. ${String(error)}`
    } finally {
      if (!this.disposed) {
        this.redraw()
      }
    }
  }

  private async send(text: string): Promise<void> {
    if (this.sending || !this.conversationId) {
      return
    }

    this.sending = true
    this.notice = 'Sending guidance…'
    this.redraw()

    try {
      this.notice = await this.source.send(this.conversationId, text)
      this.input.setValue('')
      await this.refresh()
    } catch (error) {
      this.notice = String(error)
    } finally {
      this.sending = false

      if (!this.disposed) {
        this.redraw()
      }
    }
  }

  handleInput(data: string): void {
    if (this.panel) {
      return
    }

    if (matchesKey(data, 'ctrl+o') || matchesKey(data, 'ctrl+c')) {
      this.close()
      return
    }

    if (this.composing) {
      this.input.focused = this.hasFocus

      if (matchesKey(data, 'escape')) {
        this.composing = false
      } else if (!this.sending) {
        this.input.handleInput(data)
      }

      this.redraw()
      return
    }

    if (matchesKey(data, 'escape')) {
      if (this.conversationId) {
        this.conversationId = undefined
        this.mode = 'chat'
        this.offset = 0
      } else {
        this.close()
      }
    } else if (this.conversationId) {
      this.chatInput(data)
    } else {
      const nodes = this.visibleNodes()
      const index = Math.max(
        0,
        nodes.findIndex((node) => node.row.id === this.selectedId),
      )

      if (matchesKey(data, 'tab')) {
        this.activeTab = !this.activeTab
        this.selectedId = this.visibleNodes()[0]?.row.id
      } else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const node = nodes[index]

        if (node && matchesKey(data, 'left')) {
          if (node.hasChildren && !this.collapsed.has(node.row.id)) {
            this.collapsed.add(node.row.id)
          } else {
            this.selectedId =
              nodes.slice(0, index).findLast((n) => n.depth < node.depth)?.row.id ?? node.row.id
          }
        } else if (node?.hasChildren && !this.collapsed.delete(node.row.id)) {
          this.selectedId = nodes[index + 1]?.row.id
        }
      } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        const next = index + (matchesKey(data, 'up') ? -1 : 1)
        this.selectedId = nodes[Math.max(0, Math.min(nodes.length - 1, next))]?.row.id
      } else if (matchesKey(data, 'enter') && this.selectedId) {
        this.conversationId = this.selectedId
        this.conversation = []
        this.offset = 0
        void this.refresh()
      }
    }

    this.redraw()
  }

  private chatInput(data: string): void {
    if (data === 'd' || data === 'p') {
      const target = data === 'd' ? 'details' : 'prompt'
      this.mode = this.mode === target ? 'chat' : target
      this.offset = this.mode === 'chat' ? 0 : Number.MAX_SAFE_INTEGER
    } else if (data === 'g') {
      const row = this.rows.find((item) => item.id === this.conversationId)

      if (row?.accepting) {
        this.composing = true
        this.input.focused = this.hasFocus
      } else {
        this.notice = 'Worker has stopped. Return to its coordinator for follow-up work.'
      }
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'up')) {
      this.offset = Math.min(
        this.lastBodyLines - 1,
        this.offset + (matchesKey(data, 'up') ? 1 : Math.max(1, this.height() - 10)),
      )
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, 'down')) {
      this.offset = Math.max(
        0,
        this.offset - (matchesKey(data, 'down') ? 1 : Math.max(1, this.height() - 10)),
      )
    } else if (matchesKey(data, 'end')) {
      this.offset = 0
    } else if (matchesKey(data, 'home')) {
      this.offset = this.lastBodyLines - 1
    } else if (data === 'l') {
      this.bytes = Math.min(2_000_000, this.bytes + 131072)
      void this.refresh()
    }
  }

  render(width: number): string[] {
    const active = this.rows.filter((row) => row.active).length
    const past = this.rows.length - active

    const inside = Math.max(1, width - 4)

    const top =
      this.theme.bold('Subagents') +
      '  ' +
      (this.activeTab ? `[Active ${active}]  Past ${past}` : `Active ${active}  [Past ${past}]`)
    const row = this.rows.find((item) => item.id === this.conversationId)
    const lines = this.panel
      ? this.renderPanel(inside)
      : [top, ...(row ? this.renderChat(row, inside) : this.renderList(inside))]

    if (width < 6) {
      return lines.map((line) => truncateToWidth(line, Math.max(1, width)))
    }

    const edge = (text: string) => this.theme.fg('dim', text)
    return [
      edge(`╭${'─'.repeat(width - 2)}╮`),
      ...lines.map((line) => {
        const content = truncateToWidth(line, inside)
        return edge('│ ') + content + ' '.repeat(inside - visibleWidth(content)) + edge(' │')
      }),
      edge(`╰${'─'.repeat(width - 2)}╯`),
    ]
  }

  private visibleNodes() {
    const tree = workerTree(this.rows, this.activeTab)
    let hiddenBelow = Infinity
    return tree.flatMap((node, index) => {
      if (node.depth > hiddenBelow) {
        return []
      }

      hiddenBelow = this.collapsed.has(node.row.id) ? node.depth : Infinity
      return [{ ...node, hasChildren: (tree[index + 1]?.depth ?? 0) > node.depth }]
    })
  }

  private renderList(width: number): string[] {
    const nodes = this.visibleNodes()
    const selected = Math.max(
      0,
      nodes.findIndex((node) => node.row.id === this.selectedId),
    )
    const help = wrapTextWithAnsi(
      '←→ Fold/unfold · ↑↓ Select · Tab Active/Past · Enter Open · Esc Back',
      width,
    )
    const count = Math.max(1, this.height() - 6 - help.length - Number(Boolean(this.notice)))
    const start = Math.max(0, selected - count + 1)
    const updatedWidth = width >= 80 ? 8 : 0
    const statusWidth = Math.min(15, Math.max(7, Math.floor(width / 4)))
    const taskWidth =
      width < 46 ? Math.max(1, width - statusWidth - 2) : Math.min(62, Math.floor(width * 0.39))
    const activityWidth = Math.max(
      0,
      width - taskWidth - statusWidth - 4 - (updatedWidth ? updatedWidth + 2 : 0),
    )
    const cell = (text: string, size: number) => {
      const clipped = truncateToWidth(terminalText(text).replace(/[\r\n]+/g, ' '), size)
      return clipped + ' '.repeat(Math.max(0, size - visibleWidth(clipped)))
    }
    const columns = (task: string, state: string, activity: string, updated: string) =>
      [
        cell(task, taskWidth),
        cell(state, statusWidth),
        ...(activityWidth ? [cell(activity, activityWidth)] : []),
        ...(updatedWidth ? [cell(updated, updatedWidth)] : []),
      ].join('  ')
    const lines = [
      this.theme.fg('muted', columns('Task / worker', 'Status', 'Latest activity', 'Updated')),
    ]

    for (const { row, depth, hasChildren, context } of nodes.slice(start, start + count)) {
      const role = names[row.info.role] ?? row.info.role
      const title = depth ? role : row.title || taskTitle(row.info.task) || role
      const marker = hasChildren ? (this.collapsed.has(row.id) ? '▸' : '▾') : depth ? '↳' : '·'
      const prefix = (row.id === this.selectedId ? '›' : ' ') + '  '.repeat(Math.min(depth, 5))
      const coordinator = ['task-coordinator', 'branch-orchestrator'].includes(row.info.role)
      const state =
        (row.legacy || (coordinator && row.active)) && row.taskStatus
          ? row.taskStatus
          : row.state.status
      const activity =
        row.state.summary ||
        row.state.tool ||
        (row.active && row.state.stage === 'model' ? 'Model working' : row.state.stage)
      const text = columns(
        prefix + marker + ' ' + title,
        state === 'needs_attention' ? 'Attention' : state.replaceAll('_', ' '),
        activity,
        age(row.state.updatedAt) + ' ago',
      )
      lines.push(
        this.theme.fg(
          row.id === this.selectedId
            ? 'accent'
            : state === 'needs_attention' || state === 'failed'
              ? 'warning'
              : context
                ? 'muted'
                : 'text',
          text,
        ),
      )
    }

    if (!activityWidth && nodes[selected]) {
      const { state } = nodes[selected].row
      lines.push(terminalText(state.summary || state.tool || state.stage).replace(/[\r\n]+/g, ' '))
    }

    if (!nodes.length) {
      lines.push(this.activeTab ? 'No active subagents.' : 'No past subagents yet.')
    }

    if (nodes.length > count) {
      lines.push(`${start + 1}–${Math.min(start + count, nodes.length)} / ${nodes.length}`)
    }

    lines.push(...help.map((line) => this.theme.fg('dim', line)))

    if (this.notice) {
      lines.push(terminalText(this.notice))
    }

    return lines.map((line) => truncateToWidth(line, width))
  }

  private renderChat(row: WorkerRow, width: number): string[] {
    const heading = `${names[row.info.role] ?? row.info.role} · ${status(row)}`
    const header = [
      this.theme.fg('accent', terminalText(heading)),
      terminalText(`Task: ${taskTitle(row.info.task).split('\n')[0]}`),
      terminalText(`By ${row.delegatedBy}${row.branch ? ` · ${row.branch}` : ''}`),
    ]
    let text: string

    if (this.mode === 'details') {
      text = [
        `Worker: ${row.id}`,
        `Model: ${row.info.model}${row.info.thinking ? ` · ${row.info.thinking}` : ''}`,
        `Delegated by: ${row.delegatedBy}`,
        `Task status: ${row.taskStatus ?? row.state.status}`,
        `Repository: ${row.info.projectRoot}`,
        `Worktree / candidate: ${row.info.workspace}`,
        `Branch: ${row.branch ?? 'No branch recorded; isolated candidate or local task'}`,
        `Assigned scope: ${row.info.scope.join(', ') || 'Read only'}`,
        row.info.writeLimits
          ? `Write access within scope: ${row.info.writeLimits.join(', ') || 'Read only'}`
          : '',
        `Started: ${row.info.startedAt}`,
        `Latest activity: ${row.state.updatedAt}`,
        `Prompt: press p to view the complete delegated prompt.`,
        `Trace: ${row.transcript ?? row.info.output}`,
        row.info.reviewOf ? `Reviewing the candidate after worker ${row.info.reviewOf}` : '',
        row.inferredRelationship
          ? 'Legacy relationship reconstructed from task, candidate and worker order.'
          : '',
        row.legacy
          ? 'Legacy run: guidance goes to the task coordinator.'
          : 'Guidance goes to this worker at a safe boundary; its write scope stays unchanged.',
      ]
        .filter(Boolean)
        .join('\n\n')
    } else if (this.mode === 'prompt') {
      try {
        text = JSON.stringify(JSON.parse(row.info.task), null, 2)
      } catch {
        text = row.info.task
      }
    } else {
      text =
        this.conversation
          .map((entry) => `${entry.role} · ${entry.at.slice(11, 19)}\n${entry.text}`)
          .join('\n\n') || 'Waiting for conversation events…'

      if (row.state.partial) {
        text += `\n\nassistant · streaming\n${row.state.partial}`
      }

      if (!row.active && row.state.summary) {
        text += `\n\n${row.state.status}\n${row.state.summary}`
      }
    }

    const body = terminalText(text)
      .split('\n')
      .flatMap((line) => wrapTextWithAnsi(line, width))
    this.lastBodyLines = body.length
    const help = this.composing
      ? 'Enter Send · Esc Cancel input · Ctrl+O Orchestrator'
      : 'g Guide · d Details · p Prompt · PgUp/PgDn Scroll · End Follow · Esc Back · Ctrl+O Return'
    const footer = wrapTextWithAnsi(this.theme.fg('dim', help), width)
    const queued = row.guidance.filter((message) => message.status !== 'delivered').length
    const last = row.guidance.at(-1)
    const delivery = queued
      ? row.active
        ? `${queued} guidance message(s) awaiting delivery`
        : `${queued} guidance message(s) not delivered; worker stopped`
      : last
        ? `Guidance delivered at ${last.deliveredAt?.slice(11, 19) ?? 'safe boundary'}`
        : ''
    const extras = [
      this.truncated && this.mode === 'chat'
        ? 'Showing recent history · l Load older · full trace in Details'
        : '',
      delivery,
      last?.status === 'delivered' &&
      this.notice.startsWith('Guidance ') &&
      !this.notice.includes('Parent notification failed')
        ? ''
        : this.notice,
    ]
      .filter(Boolean)
      .map(terminalText)
    const available = Math.max(
      1,
      this.height() - header.length - footer.length - extras.length - (this.composing ? 2 : 1) - 2,
    )
    const end = Math.max(available, body.length - Math.max(0, this.offset))
    const visible = body.slice(Math.max(0, end - available), end)
    return [
      ...header,
      '',
      ...visible,
      ...extras,
      ...footer,
      ...(this.composing ? this.input.render(width) : []),
    ]
  }

  private renderPanel(width: number): string[] {
    const nodes = workerTree(this.rows, true)
    const lines = [this.theme.bold('Subagents'), this.theme.fg('dim', '/workers to open')]

    const capacity = Math.max(0, Math.floor((this.height() - 5) / 2))

    for (const { row, depth, context } of nodes.slice(0, capacity)) {
      const prefix = `${'  '.repeat(Math.min(depth, 2))}${depth ? '↳ ' : ''}`
      lines.push(
        this.theme.fg(
          context ? 'dim' : 'accent',
          terminalText(`${prefix}${names[row.info.role] ?? row.info.role} · ${status(row)}`),
        ),
      )
      lines.push(terminalText(`${prefix}${row.state.summary ?? taskTitle(row.info.task)}`))
    }

    if (!nodes.length) {
      lines.push('No active subagents')
    } else if (nodes.length > capacity) {
      lines.push(`+${nodes.length - capacity} more · /workers`)
    }

    return lines.slice(0, Math.max(3, this.height())).map((line) => truncateToWidth(line, width))
  }
}
