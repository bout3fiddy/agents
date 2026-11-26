import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { callIdentity, LiveWorker, messageEntries, messageText } from './worker-live.ts'
import { guidanceText } from './worker-mailbox.ts'

/** Observe and steer the existing SDK session; never fork, resume or abort it for navigation. */
export function attachLiveSession(
  session: AgentSession,
  live: LiveWorker,
  invalidateResult: () => void,
) {
  let polling = Promise.resolve()
  let error: unknown
  const deliveries = new Set<Promise<void>>()
  const track = (promise: Promise<void>) => {
    deliveries.add(promise)
    void promise
      .catch((failure: unknown) => {
        error = failure
      })
      .finally(() => {
        deliveries.delete(promise)
      })
  }
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update') {
      track(live.update({ stage: 'model', partial: messageText(event.message) }, true))
    }

    if (event.type === 'message_start' && event.message.role === 'user') {
      try {
        const value = JSON.parse(messageText(event.message)) as { piWorkerGuidance?: string }

        if (value.piWorkerGuidance) {
          invalidateResult()
          track(live.mailbox.acknowledge(value.piWorkerGuidance))
        }
      } catch {
        // Ordinary user assignments are not guidance receipts.
      }
    }

    if (event.type === 'message_end') {
      for (const { role, text, ...metadata } of messageEntries(event.message)) {
        track(live.append(role, text, metadata))
      }

      track(live.update({ partial: undefined }))
    }

    if (event.type === 'tool_execution_start') {
      track(live.update({ stage: 'tool', tool: event.toolName, partial: undefined }))
      track(
        live.append('tool', `${event.toolName} ${JSON.stringify(event.args)}`, callIdentity(event)),
      )
    }

    if (event.type === 'tool_execution_end') {
      const identity = callIdentity(event)

      if (identity.parentToolCallId && event.isError) {

        // Nested tools need not emit a model-facing toolResult. Never copy their successful output.
        const reason = messageText(event.result).slice(0, 200) || 'Nested tool failed'
        track(live.append('toolResult', reason, { ...identity, isError: true }))
      }

      track(live.update({ stage: 'model', tool: undefined }))
    }
  })

  function poll(): Promise<void> {
    polling = polling
      .then(async () => {
        await live.mailbox.queue(async (message) => {
          invalidateResult()
          await session.steer(guidanceText(message))
        })
      })
      .catch((failure: unknown) => {
        error = failure
      })
    return polling
  }

  const timer = setInterval(() => {
    void poll()
  }, 300)
  return {
    async settleGuidance() {
      await poll()
      await Promise.all(deliveries)

      if (error) {
        throw error
      }
    },
    async dispose() {
      clearInterval(timer)
      unsubscribe()
      await polling
      await Promise.all(deliveries)
      await live.settle()
    },
  }
}
