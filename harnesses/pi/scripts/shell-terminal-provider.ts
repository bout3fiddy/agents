/** Deterministic model for the interactive shell activity PTY fixture. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

type Arguments = Record<string, string | Record<string, string>>

// The host inspects a pull request with reads and shell calls that share one activity row.
const calls: { name: string; arguments: Arguments }[] = [
  { name: 'project_read', arguments: { path: 'guide.md' } },
  {
    name: 'bash',
    arguments: { command: 'git show -s --format=%B refs/pull/61/head # RAW_FIRST_COMMAND' },
  },
  {
    name: 'bash',
    arguments: {
      command: 'sleep 0.6 && git merge --no-commit refs/pull/61/head # RAW_SECOND_COMMAND',
    },
  },
  { name: 'project_read', arguments: { path: 'missing-file.md' } },
]

export default function shellTerminalProvider(pi: ExtensionAPI) {
  pi.registerProvider('shell-terminal', {
    api: 'openai-completions',
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture-only',
    models: [
      {
        id: 'scripted',
        name: 'Scripted terminal fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 300000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream()
      const index = context.messages.filter((entry) => entry.role === 'toolResult').length
      const call = calls[index]
      const part = call
        ? {
            type: 'toolCall' as const,
            id: 'shell-' + index,
            name: call.name,
            arguments: { ...call.arguments },
          }
        : { type: 'text' as const, text: 'Terminal fixture finished.' }
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [part],
        stopReason: call ? 'toolUse' : 'stop',
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }

      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message })

        if (part.type === 'toolCall') {
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: part, partial: message })
        } else {
          stream.push({ type: 'text_start', contentIndex: 0, partial: message })
          stream.push({ type: 'text_delta', contentIndex: 0, delta: part.text, partial: message })
          stream.push({ type: 'text_end', contentIndex: 0, content: part.text, partial: message })
        }

        stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message })
        stream.end()
      })
      return stream
    },
  })
}
