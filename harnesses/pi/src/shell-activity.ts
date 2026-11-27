import type { MessageEndEvent, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  describeShell,
  shellOutcome,
  type ShellOperation,
  type ShellOutcome,
} from './shell-outcome.ts'

export interface ShellCall {
  id: string
  command: string
  purpose: string
  outcome?: ShellOutcome
}

interface Group {
  operation: ShellOperation
  calls: ShellCall[]
  open: boolean
}

export class ShellActivity {
  private readonly calls = new Map<string, { group: Group; call: ShellCall }>()
  private last?: Group

  find(id: string) {
    return this.calls.get(id)
  }

  add(id: string, command: string) {
    const existing = this.find(id)

    if (existing) {
      return existing
    }

    const { purpose, operation } = describeShell(command)
    const target = operation ?? { key: 'command:' + command, title: purpose }
    const last = this.last
    const group =
      last &&
      last.operation.key === target.key &&
      (!target.repository ||
        !last.operation.repository ||
        target.repository === last.operation.repository)
        ? last
        : { operation: { ...target }, calls: [], open: false }

    group.operation.repository ??= target.repository
    const call: ShellCall = { id, command, purpose }
    group.calls.push(call)
    this.calls.set(id, { group, call })
    this.last = group
    return { group, call }
  }

  boundary() {
    this.last = undefined
  }

  observe(message: MessageEndEvent['message']) {
    if (message.role === 'toolResult') {
      const item = this.find(message.toolCallId)

      if (item && message.toolName === 'bash') {
        const output = message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
        item.call.outcome = shellOutcome(item.call.command, output, message.isError)
      }

      return
    }

    if (message.role === 'custom' && !message.display) {
      return
    }

    if (message.role !== 'assistant') {
      this.boundary()
      return
    }

    if (message.content.some((part) => part.type === 'text' && part.text.trim())) {
      this.boundary()
    }

    for (const part of message.content) {
      if (part.type !== 'toolCall') {
        continue
      }

      if (part.name === 'bash' && typeof part.arguments.command === 'string') {
        this.add(part.id, part.arguments.command)
      } else {
        this.boundary()
      }
    }
  }

  replay(entries: SessionEntry[]) {
    this.calls.clear()
    this.boundary()

    for (const entry of entries) {
      if (entry.type === 'message') {
        this.observe(entry.message)
      } else if (
        (entry.type === 'custom_message' && entry.display) ||
        entry.type === 'branch_summary' ||
        entry.type === 'compaction'
      ) {
        this.boundary()
      }
    }

    for (const { call } of this.calls.values()) {
      call.outcome ??= { kind: 'notice', text: 'No result recorded', key: 'missing-result' }
    }
  }
}
