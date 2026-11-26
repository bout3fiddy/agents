import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  AgentSession,
  InteractiveMode,
  type ExtensionContext,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent'
import { Spacer, TruncatedText, type Container } from '@earendil-works/pi-tui'
import { invariant } from './invariant.ts'

type QueueMode = 'steer' | 'followUp'
type Images = NonNullable<PromptOptions['images']>
type UserMessage = Extract<AgentMessage, { role: 'user' }>

// Narrow adapter for the pinned Pi editor. Its follow-up action is the configured Alt+Enter key.
type EditorAction = {
  session: AgentSession
  editor: {
    getText(): string
    getExpandedText?(): string
    setText(text: string): void
    addToHistory?(text: string): void
  }
  compactionQueuedMessages: { text: string; mode: QueueMode }[]
  getAppKeyDisplay(action: 'app.message.followUp'): string
  pendingMessagesContainer: Container
  updatePendingMessagesDisplay(): void
  ui: { requestRender(): void }
  handleFollowUp(): Promise<void>
  isExtensionCommand(text: string): boolean
  showStatus(text: string): void
  showError(text: string): void
}

// The public input entry points of the pinned AgentSession. Ownership uses its session manager.
type SessionInput = {
  sessionManager: unknown
  isStreaming: boolean
  prompt(text: string, options?: PromptOptions): Promise<void>
  steer(text: string, images?: Images, options?: { source?: string }): Promise<unknown>
  followUp(text: string, images?: Images, options?: { source?: string }): Promise<unknown>
}

// The held instruction. Editor text has not been expanded; a queued message already has been.
type Correction = {
  text: string
  images: Images | undefined
  expand: boolean
  queued: { message: UserMessage; mode: QueueMode } | undefined
}

// Requested: abort was asked for. Sending: settlement was observed and the prompt is starting.
type Handoff = { correction: Correction; phase: 'requested' | 'sending' }

const waiting = 'waiting for the current operation to stop'

// Pi 1.5.2 exposes queue labels and agent queues only through private fields. Read them fresh:
// both arrays are replaced when Pi clears or drains a queue.
function pendingQueue(session: AgentSession, mode: QueueMode) {
  const agent = session.agent as unknown as {
    steeringQueue?: { messages?: AgentMessage[] }
    followUpQueue?: { messages?: AgentMessage[] }
  }
  const messages = (mode === 'steer' ? agent.steeringQueue : agent.followUpQueue)?.messages
  const labelField = mode === 'steer' ? '_steeringMessages' : '_followUpMessages'
  const labels: unknown = Reflect.get(session, labelField)
  const emitQueueUpdate: unknown = Reflect.get(session, '_emitQueueUpdate')
  invariant(Array.isArray(messages), 'Pending messages must be available')
  invariant(Array.isArray(labels), 'Pending labels must be available')
  invariant(typeof emitQueueUpdate === 'function', 'Queue updates must be available')
  return {
    messages,
    labels: labels as string[],
    notify: () => {
      emitQueueUpdate.call(session)
    },
  }
}

function messageText(message: UserMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  return message.content.find((part) => part.type === 'text')?.text ?? ''
}

// Remove the first human message of one mode. Pi keeps a text-only label list for its panel;
// match its label by position from the tail, never by text: people and extensions can send
// identical messages. Validate both lists before mutating either.
function takeQueued(
  session: AgentSession,
  mode: QueueMode,
  human: WeakSet<AgentMessage>,
): Correction | undefined {
  const queue = pendingQueue(session, mode)
  const index = queue.messages.findIndex((message) => human.has(message))
  const message = queue.messages[index]

  if (!message) {
    return undefined
  }

  invariant(message.role === 'user', 'Human pending messages are user messages')
  const text = messageText(message)
  let label = queue.labels.length - 1

  for (let after = index + 1; after < queue.messages.length; after++) {
    if (queue.messages[after]?.role === 'user') {
      label--
    }
  }

  invariant(queue.labels[label] === text, 'Pending label must match its message')
  queue.messages.splice(index, 1)
  queue.labels.splice(label, 1)
  queue.notify()
  const images =
    typeof message.content === 'string'
      ? []
      : message.content.filter((part): part is Images[number] => part.type === 'image')
  return {
    text,
    images: images.length ? images : undefined,
    expand: false,
    queued: { message, mode },
  }
}

// Follow the SDK input source, not the text. Nested extension submissions start their own scope.
// The /steer command is human input that Pi submits through the extension API.
class HumanOrigin {
  readonly messages = new WeakSet<AgentMessage>()
  private readonly scope = new AsyncLocalStorage<{ human: boolean }>()
  private readonly command = new AsyncLocalStorage<{ human: boolean }>()

  run<T>(human: boolean, send: () => Promise<T>): Promise<T> {
    const input = { human }
    return this.scope.run(input, send).finally(() => {
      input.human = false
    })
  }

  runCommand(send: () => void): void {
    const input = { human: true }

    try {
      this.command.run(input, send)
    } finally {
      input.human = false
    }
  }

  takeCommand(): boolean {
    const input = this.command.getStore()
    const human = input?.human === true

    if (input) {
      input.human = false
    }

    return human
  }

  mark(message: AgentMessage): void {
    const input = this.scope.getStore()

    if (input?.human && message.role === 'user') {
      input.human = false
      this.messages.add(message)
    }
  }

  dispose(): void {
    this.scope.disable()
    this.command.disable()
  }
}

/**
 * Alt+Enter while the owning foreground run works: cancel it and send one human correction next.
 * Editor text is the correction; an empty editor takes the first pending human steer, then the
 * first human follow-up. One handoff per session waits for observed settlement; an uncooperative
 * operation keeps it waiting. Enter, /steer, background tasks and other sessions are unchanged.
 */
export class InterruptInput {
  private readonly ctx: ExtensionContext
  private readonly origin = new HumanOrigin()
  private readonly restorers: (() => void)[] = []
  private session: AgentSession | undefined
  private detachSession: (() => void) | undefined
  private tui: EditorAction | undefined
  private handoff: Handoff | undefined
  private closed = false

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    this.installEditor()
    this.installSession()
  }

  /** Submit a /steer command's message as human input. */
  steer(send: () => void): void {
    this.origin.runCommand(send)
  }

  uninstall(): void {
    invariant(!this.closed, 'Interrupt input is installed once')
    this.closed = true

    for (const restore of this.restorers.splice(0).reverse()) {
      restore()
    }

    this.detachSession?.()
    this.detachSession = undefined
    this.session = undefined
    this.origin.dispose()
    this.refresh()
    this.tui = undefined
  }

  private installEditor(): void {
    const owner = this.ctx.sessionManager
    const editor = InteractiveMode.prototype as unknown as EditorAction
    const handleFollowUp = editor.handleFollowUp
    const update = editor.updatePendingMessagesDisplay
    invariant(typeof editor.isExtensionCommand === 'function', 'Command lookup must be available')
    invariant(typeof editor.showError === 'function', 'Error display must be available')
    const owns = (tui: EditorAction) => !this.closed && tui.session.sessionManager === owner
    const interrupt = (tui: EditorAction) => this.interrupt(tui, handleFollowUp)
    const decorate = (tui: EditorAction) => {
      this.attach(tui.session, tui)
      this.decorate(tui)
    }
    editor.handleFollowUp = async function () {
      return owns(this) ? interrupt(this) : handleFollowUp.call(this)
    }
    editor.updatePendingMessagesDisplay = function () {
      update.call(this)

      if (owns(this)) {
        decorate(this)
      }
    }
    const replaced = {
      handleFollowUp: editor.handleFollowUp,
      update: editor.updatePendingMessagesDisplay,
    }
    this.restorers.push(() => {
      if (editor.handleFollowUp === replaced.handleFollowUp) {
        editor.handleFollowUp = handleFollowUp
      }

      if (editor.updatePendingMessagesDisplay === replaced.update) {
        editor.updatePendingMessagesDisplay = update
      }
    })
  }

  private installSession(): void {
    const owner = this.ctx.sessionManager
    const input = AgentSession.prototype as unknown as SessionInput
    const { prompt, steer, followUp } = input
    const owns = (session: SessionInput) => !this.closed && session.sessionManager === owner
    const takeCommand = () => this.origin.takeCommand()
    const track = <T>(session: SessionInput, human: boolean, send: () => Promise<T>) => {
      this.attach(session as unknown as AgentSession)
      return this.origin.run(human, send)
    }
    const interactive = (options?: { source?: string }) =>
      (options?.source ?? 'interactive') === 'interactive'
    input.prompt = function (text, options) {
      const command = takeCommand()

      if (!owns(this)) {
        return prompt.call(this, text, options)
      }

      const queued = options?.streamingBehavior !== undefined && this.isStreaming
      const human = (command || interactive(options)) && queued
      return track(this, human, () => prompt.call(this, text, options))
    }
    input.steer = function (text, images, options) {
      if (!owns(this)) {
        return steer.call(this, text, images, options)
      }

      return track(this, interactive(options), () => steer.call(this, text, images, options))
    }
    input.followUp = function (text, images, options) {
      if (!owns(this)) {
        return followUp.call(this, text, images, options)
      }

      return track(this, interactive(options), () => followUp.call(this, text, images, options))
    }
    const replaced = { prompt: input.prompt, steer: input.steer, followUp: input.followUp }

    // Restore only our own layer; a later wrapper stays in place and our layer passes through.
    this.restorers.push(() => {
      if (input.prompt === replaced.prompt) {
        input.prompt = prompt
      }

      if (input.steer === replaced.steer) {
        input.steer = steer
      }

      if (input.followUp === replaced.followUp) {
        input.followUp = followUp
      }
    })
  }

  // Bind to the owning session once: mark human queue entries, count a held correction as
  // pending input so idle wakers defer to it, and retire panel lines when a run settles.
  private attach(session: AgentSession, tui?: EditorAction): void {
    this.tui = tui ?? this.tui

    if (this.session === session) {
      return
    }

    this.detachSession?.()
    this.session = session
    const agent = session.agent
    const { steer, followUp } = agent
    invariant(
      !Object.hasOwn(agent, 'steer') && !Object.hasOwn(agent, 'followUp'),
      'Agent unwrapped',
    )
    invariant(!Object.hasOwn(session, 'pendingMessageCount'), 'Pending count is not overridden')
    const count = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'pendingMessageCount')
    invariant(typeof count?.get === 'function', 'Pending message count must be a getter')
    const base = count.get
    agent.steer = (message) => {
      this.origin.mark(message)
      steer.call(agent, message)
    }
    agent.followUp = (message) => {
      this.origin.mark(message)
      followUp.call(agent, message)
    }
    Object.defineProperty(session, 'pendingMessageCount', {
      configurable: true,
      get: () => (base.call(session) as number) + (this.handoff && !session.isStreaming ? 1 : 0),
    })
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' || event.type === 'agent_settled') {
        this.refresh()
      }
    })
    this.detachSession = () => {
      unsubscribe()
      Reflect.deleteProperty(agent, 'steer')
      Reflect.deleteProperty(agent, 'followUp')
      Reflect.deleteProperty(session, 'pendingMessageCount')
    }
  }

  private async interrupt(tui: EditorAction, submit: () => Promise<void>): Promise<void> {
    this.attach(tui.session, tui)

    if (this.handoff) {
      tui.showStatus(`Interrupt already requested; ${waiting}`)
      return
    }

    // Idle or standalone compaction keeps Pi's behavior: send now, or queue after compaction.
    if (!tui.session.isStreaming) {
      return submit.call(tui)
    }

    const typed = (tui.editor.getExpandedText?.() ?? tui.editor.getText()).trim()

    // Extension commands such as /steer run immediately and never cancel work.
    if (typed && tui.isExtensionCommand(typed)) {
      return submit.call(tui)
    }

    let correction: Correction | undefined

    try {
      correction = typed ? this.fromEditor(tui, typed) : this.takeHuman(tui)
    } catch (error) {
      tui.showError(`Could not interrupt: ${String(error)}`)
      return
    }

    if (!correction) {
      const key = tui.getAppKeyDisplay('app.message.followUp')
      tui.showStatus(`No pending human message; type a correction, then press ${key} to interrupt`)
      return
    }

    await this.handOff(tui, correction)
  }

  private fromEditor(tui: EditorAction, text: string): Correction {
    tui.editor.addToHistory?.(text)
    tui.editor.setText('')
    return { text, images: undefined, expand: true, queued: undefined }
  }

  // Steers before follow-ups. Pi's compaction queue only holds editor input submitted meanwhile.
  private takeHuman(tui: EditorAction): Correction | undefined {
    for (const mode of ['steer', 'followUp'] as const) {
      const queued = takeQueued(tui.session, mode, this.origin.messages)

      if (queued) {
        return queued
      }

      const index = tui.compactionQueuedMessages.findIndex((message) => message.mode === mode)
      const [message] = index < 0 ? [] : tui.compactionQueuedMessages.splice(index, 1)

      if (message) {
        return { text: message.text, images: undefined, expand: true, queued: undefined }
      }
    }

    return undefined
  }

  private hasHuman(tui: EditorAction): boolean {
    return (
      tui.compactionQueuedMessages.length > 0 ||
      (['steer', 'followUp'] as const).some((mode) =>
        pendingQueue(tui.session, mode).messages.some((message) =>
          this.origin.messages.has(message),
        ),
      )
    )
  }

  // AgentSession.abort() requests cancellation and resolves only after the run settles. A tool
  // that ignores its signal keeps the handoff requested. Nothing polls or starts another turn.
  private async handOff(tui: EditorAction, correction: Correction): Promise<void> {
    const session = tui.session
    const handoff: Handoff = { correction, phase: 'requested' }
    let accepted = false
    this.handoff = handoff
    this.refresh()
    tui.showStatus(`Interrupt requested; ${waiting}`)

    try {
      await session.abort()

      if (this.closed || this.session !== session) {
        throw new Error('the session closed before the correction was sent')
      }

      invariant(this.handoff === handoff, 'One interrupt handoff per session')
      handoff.phase = 'sending'
      this.refresh()
      tui.showStatus('Stopped the current operation; sending your correction')

      // A run started meanwhile receives the correction as its next steer, never in parallel.
      await session.prompt(correction.text, {
        images: correction.images,
        expandPromptTemplates: correction.expand,
        streamingBehavior: 'steer',
        preflightResult: (disposition) => {
          accepted = true
          this.release(handoff)

          if (disposition === 'queued') {
            tui.showStatus('Another turn started first; your correction steers it next')
          }
        },
      })
      accepted = true
    } catch (error) {
      if (!accepted) {
        this.restore(tui, session, correction)
      }

      const outcome = accepted ? 'The correction turn failed' : 'Could not send your correction'
      tui.showError(`${outcome}: ${String(error)}`)
    } finally {
      this.release(handoff)
    }
  }

  // Keep rejected input: a queued message returns to the front of its queue with attachments;
  // editor text, or anything for a closed session, returns to the editor before any new draft.
  private restore(tui: EditorAction, session: AgentSession, correction: Correction): void {
    if (correction.queued && !this.closed && this.session === session) {
      const queue = pendingQueue(session, correction.queued.mode)
      queue.messages.unshift(correction.queued.message)
      queue.labels.unshift(correction.text)
      queue.notify()
      return
    }

    const draft = tui.editor.getExpandedText?.() ?? tui.editor.getText()
    tui.editor.setText([correction.text, draft].filter((text) => text.trim()).join('\n\n'))
  }

  private release(handoff: Handoff): void {
    if (this.handoff === handoff) {
      this.handoff = undefined
      this.refresh()
    }
  }

  private refresh(): void {
    this.tui?.updatePendingMessagesDisplay()
    this.tui?.ui.requestRender()
  }

  private decorate(tui: EditorAction): void {
    const line = this.panelLine(tui)

    if (!line) {
      return
    }

    const panel = tui.pendingMessagesContainer

    if (panel.children.length === 0) {
      panel.addChild(new Spacer(1))
    }

    panel.addChild(new TruncatedText(this.ctx.ui.theme.fg('dim', line), 1, 0))
  }

  private panelLine(tui: EditorAction): string | undefined {
    if (this.handoff) {
      const state = this.handoff.phase === 'requested' ? waiting : 'sending it next'
      return `Interrupting with: ${this.handoff.correction.text} (${state})`
    }

    if (tui.session.isStreaming && this.hasHuman(tui)) {
      const key = tui.getAppKeyDisplay('app.message.followUp')
      return `↳ ${key} on empty: interrupt and send the first human message now`
    }

    return undefined
  }
}
