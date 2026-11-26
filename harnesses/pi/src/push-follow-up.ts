import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  InteractiveMode,
  type AgentSession,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { TruncatedText, type Container } from '@earendil-works/pi-tui'
import { invariant } from './invariant.ts'

// Narrow adapter for the pinned Pi editor: its extension API can submit a steer, but the only
// dequeue operation would also discard unrelated messages, including hidden extension events.
type FollowUpAction = {
  session: AgentSession
  editor: { getText(): string }
  compactionQueuedMessages: { mode: 'steer' | 'followUp' }[]
  getAppKeyDisplay(action: 'app.message.followUp'): string
  pendingMessagesContainer: Container
  updatePendingMessagesDisplay(): void
  ui: { requestRender(): void }
  handleFollowUp(): Promise<void>
  showStatus(text: string): void
}

// Pi 1.5.2 has public label readers, but no public operation to move a single pending label.
function pendingDisplay(session: AgentSession) {
  const {
    _followUpMessages: followUpLabels,
    _steeringMessages: steeringLabels,
    _emitQueueUpdate: notify,
  } = session as unknown as {
    _followUpMessages: string[]
    _steeringMessages: string[]
    _emitQueueUpdate(this: AgentSession): void
  }
  invariant(Array.isArray(followUpLabels), 'Follow-up labels must be available')
  invariant(Array.isArray(steeringLabels), 'Steering labels must be available')
  invariant(typeof notify === 'function', 'Queue updates must be available')
  return { followUpLabels, steeringLabels, notify: notify.bind(session) }
}

function pendingFollowUps(session: AgentSession): AgentMessage[] {
  const { followUpQueue } = session.agent as unknown as {
    followUpQueue?: { messages?: AgentMessage[] }
  }
  const pending = followUpQueue?.messages
  invariant(Array.isArray(pending), 'Pending follow-up messages must be available')
  return pending
}

// Move the original object (including attachments) while the JS event loop cannot drain it.
// Pi keeps a second, text-only list for its pending display. Validate both before any mutation.
function promote(session: AgentSession, human: WeakSet<AgentMessage>): boolean {
  const pending = pendingFollowUps(session)
  const index = pending.findIndex((message) => human.has(message))
  const message = pending[index]

  if (!message || message.role !== 'user') {
    return false
  }

  const text =
    typeof message.content === 'string'
      ? message.content
      : (message.content.find((part) => part.type === 'text')?.text ?? '')
  const display = pendingDisplay(session)

  // The display can still include a drained prefix until message_start. Match from the tail
  // by position, not by text: an extension and a person can send identical messages.
  let label = display.followUpLabels.length - 1

  for (let after = index + 1; after < pending.length; after++) {
    if (pending[after]?.role === 'user') {
      label--
    }
  }

  invariant(display.followUpLabels[label] === text, 'Pending follow-up label must match')
  pending.splice(index, 1)
  session.agent.steer(message)
  display.followUpLabels.splice(label, 1)
  display.steeringLabels.push(text)
  display.notify()
  return true
}

// Follow the SDK's input source, not the submitted text. This includes the editor's deferred
// flush after compaction. Nested extension submissions start their own source scope.
function trackOrigin(session: AgentSession, human: WeakSet<AgentMessage>): () => void {
  const origin = new AsyncLocalStorage<{ human: boolean }>()
  const prompt = session.prompt
  const followUp = session.followUp
  const enqueue = session.agent.followUp
  const track = <T>(isHuman: boolean, send: () => Promise<T>) => {
    const input = { human: isHuman }
    return origin.run(input, send).finally(() => {
      input.human = false
    })
  }
  session.prompt = (text, options) =>
    track(
      options?.streamingBehavior === 'followUp' &&
        (options.source ?? 'interactive') === 'interactive',
      () => prompt.call(session, text, options),
    )
  session.followUp = (text, images, options) =>
    track((options?.source ?? 'interactive') === 'interactive', () =>
      followUp.call(session, text, images, options),
    )
  session.agent.followUp = (message) => {
    const input = origin.getStore()

    if (input?.human && message.role === 'user') {
      input.human = false
      human.add(message)
    }

    enqueue.call(session.agent, message)
  }
  return () => {
    session.agent.followUp = enqueue
    session.followUp = followUp
    session.prompt = prompt
    origin.disable()
  }
}

// Pi already renders the steer receipt and configured edit-all key. Only the push action is
// specific to pih. Refresh it with Pi's pending display so withdrawal and delivery retire it.
function trackPushHint(
  tui: FollowUpAction,
  ctx: ExtensionContext,
  human: WeakSet<AgentMessage>,
): () => void {
  const update = tui.updatePendingMessagesDisplay
  const key = tui.getAppKeyDisplay('app.message.followUp')
  const label = ctx.ui.theme.fg('dim', `↳ ${key} on empty: push next human follow-up`)
  const hint = new TruncatedText(label, 1, 0)
  tui.updatePendingMessagesDisplay = () => {
    update.call(tui)
    const waiting =
      tui.compactionQueuedMessages.some((message) => message.mode === 'followUp') ||
      (!tui.session.isIdle && pendingFollowUps(tui.session).some((message) => human.has(message)))

    if (waiting) {
      tui.pendingMessagesContainer.addChild(hint)
    }
  }
  const clear = () => {
    tui.pendingMessagesContainer.removeChild(hint)
    tui.ui.requestRender()
  }
  const unsubscribe = tui.session.subscribe((event) => {
    if (event.type === 'agent_settled' && tui.session.isIdle) {
      clear()
    }
  })
  return () => {
    unsubscribe()
    tui.updatePendingMessagesDisplay = update
    clear()
  }
}

export function installPush(ctx: ExtensionContext): () => void {
  const interactive = InteractiveMode.prototype as unknown as FollowUpAction
  const submit = interactive.handleFollowUp
  const owner = ctx.sessionManager
  const human = new WeakSet<AgentMessage>()
  let restoreAgent: (() => void) | undefined
  let restoreHint: (() => void) | undefined
  interactive.handleFollowUp = async function () {
    if (this.session.sessionManager !== owner) {
      return submit.call(this)
    }

    restoreAgent ??= trackOrigin(this.session, human)
    restoreHint ??= trackPushHint(this, ctx, human)

    if (this.editor.getText().trim()) {
      return submit.call(this)
    }

    const compacting = this.compactionQueuedMessages.find((message) => message.mode === 'followUp')

    if (compacting) {
      compacting.mode = 'steer'
      this.updatePendingMessagesDisplay()
      this.ui.requestRender()
    } else if (!this.session.isIdle) {
      try {
        if (!promote(this.session, human)) {
          this.showStatus('No waiting human follow-up; steering messages already have priority')
        }
      } catch (error) {
        ctx.ui.notify(`Could not push the follow-up: ${String(error)}`, 'error')
      }
    }
  }
  return () => {
    interactive.handleFollowUp = submit
    restoreAgent?.()
    restoreHint?.()
  }
}
