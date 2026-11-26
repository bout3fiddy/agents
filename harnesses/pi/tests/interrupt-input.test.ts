import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  AgentSession,
  initTheme,
  InteractiveMode,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CustomEditor,
  type ExtensionAPI,
  type ExtensionUIContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { captureSession } from './session-support.ts'

type Reply = AssistantMessage['content']

const interruptKey = '\x1b\r'
const steering = fileURLToPath(new URL('../src/steering.ts', import.meta.url))

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, promise }
}

// A tool that blocks until released. A cooperative tool also returns when its signal aborts.
function blockingTool(name: string, cooperative: boolean, events: string[]) {
  let started = latch()
  let release = latch()
  const tool: ToolDefinition = {
    name,
    label: name,
    description: 'Wait for the test fixture',
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const natural = release.promise.then(() => 'natural')
      const cancelled = new Promise<string>((resolve) => {
        if (cooperative) {
          signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        }
      })
      events.push(`${name}:start`)
      started.release()
      const outcome = await Promise.race([natural, cancelled])
      events.push(`${name}:${outcome}`)
      return { content: [{ type: 'text', text: `${name} ${outcome}` }], details: {} }
    },
  }
  return {
    tool,
    call: { type: 'toolCall' as const, id: name, name, arguments: {} },
    started: () => started.promise,
    release: () => release.release(),
    rearm: () => {
      started = latch()
      release = latch()
    },
  }
}

// Mount the production Pi editor, input actions and pending panel without a terminal.
function editorFor(session: AgentSession) {
  initTheme('dark', false)
  const host = { session, setRebindSession() {}, setBeforeSessionInvalidate() {} }
  const tui = new InteractiveMode(host as AgentSessionRuntime) as unknown as {
    editor: CustomEditor
    chatContainer: Component
    pendingMessagesContainer: Component
    getAppKeyDisplay(action: 'app.message.followUp'): string
    ui: { requestRender(): void }
    setupKeyHandlers(): void
    setupEditorSubmitHandler(): void
    isInitialized: boolean
    handleEvent(event: AgentSessionEvent): Promise<void>
    createExtensionUIContext(): ExtensionUIContext
    pendingUserInputs: string[]
  }
  tui.isInitialized = true
  tui.ui.requestRender = () => {}
  tui.setupKeyHandlers()
  tui.setupEditorSubmitHandler()
  return tui
}

function userTexts(request: string): string[] {
  const messages = JSON.parse(request) as {
    role: string
    content: string | { type: string; text?: string }[]
  }[]
  return messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => part.text ?? '').join(''),
    )
}

function count(texts: string[], text: string): number {
  return texts.filter((candidate) => candidate === text).length
}

// Real SDK session with the pih steering extension. The fake provider fails any request sent
// with an already aborted signal, as a real provider does, and counts it separately.
async function fixture(tools: ReturnType<typeof blockingTool>[]) {
  const root = await mkdtemp(join(tmpdir(), 'pi-interrupt-'))
  const requests: string[] = []
  const replies: Reply[] = []
  const settled: { aborted: boolean; pending: boolean }[] = []
  const waiters: { count: number; resolve(): void }[] = []
  const holder: { session?: AgentSession; cancelledRequests: number } = { cancelledRequests: 0 }
  const observe = (pi: ExtensionAPI) => {
    pi.on('agent_settled', (event, ctx) => {
      settled.push({ aborted: event.aborted, pending: ctx.hasPendingMessages() })

      for (const waiter of waiters.splice(0)) {
        if (settled.length >= waiter.count) {
          waiter.resolve()
        } else {
          waiters.push(waiter)
        }
      }
    })
  }
  const { session, runtime } = await captureSession(
    root,
    root,
    [observe],
    async (context) => {
      if (holder.session?.agent.signal?.aborted) {
        holder.cancelledRequests++
        throw new Error('Request cancelled by the fixture')
      }

      requests.push(JSON.stringify(context.messages))
      return replies.shift() ?? [{ type: 'text', text: 'Done' }]
    },
    { extensionPaths: [steering], customTools: tools.map(({ tool }) => tool) },
  )
  holder.session = session
  const tui = editorFor(session)
  const offPanel = session.subscribe((event) => {
    if (event.type === 'queue_update') {
      return tui.handleEvent(event)
    }
  })
  await session.bindExtensions({ mode: 'tui', uiContext: tui.createExtensionUIContext() })
  const send = (text: string, key: string) => {
    tui.editor.setText(text)
    tui.editor.handleInput(key)
  }
  const render = (component: Component) => stripTerminalSequences(component.render(200).join('\n'))
  return {
    session,
    tui,
    requests,
    replies,
    settled,
    holder,
    send,
    panel: () => render(tui.pendingMessagesContainer),
    chat: () => render(tui.chatContainer),
    settledCount: (total: number) =>
      new Promise<void>((resolve) => {
        if (settled.length >= total) {
          resolve()
        } else {
          waiters.push({ count: total, resolve })
        }
      }),

    // The SDK emits queue_update before core enqueue. Let the editor finish its submit handler.
    async submitQueued(text: string, key: string) {
      const done = latch()
      const off = session.subscribe((event) => {
        if (event.type === 'queue_update') {
          off()
          done.release()
        }
      })
      send(text, key)
      await done.promise
      await setImmediate()
    },
    steeringQueue: () =>
      (session.agent as unknown as { steeringQueue: { messages: AgentMessage[] } }).steeringQueue
        .messages,
    async close() {
      for (const tool of tools) {
        tool.release()
      }

      const agent = session.agent
      await session.abort()
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      offPanel()
      assert.equal(Object.hasOwn(agent, 'steer'), false, 'Agent wrappers are removed')
      assert.equal(Object.hasOwn(session, 'pendingMessageCount'), false)
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const prototypes = () => ({
  action: Reflect.get(InteractiveMode.prototype, 'handleFollowUp'),
  panel: Reflect.get(InteractiveMode.prototype, 'updatePendingMessagesDisplay'),
  prompt: Reflect.get(AgentSession.prototype, 'prompt'),
  steer: Reflect.get(AgentSession.prototype, 'steer'),
  followUp: Reflect.get(AgentSession.prototype, 'followUp'),
})

test(
  'empty Alt+Enter cancels a blocked tool and sends the first human steer next, once',
  { timeout: 20_000 },
  async () => {
    const events: string[] = []
    const block = blockingTool('block', true, events)
    const original = prototypes()
    const it = await fixture([block])
    const { session, tui } = it
    const key = tui.getAppKeyDisplay('app.message.followUp')
    const hint = `${key} on empty: interrupt and send the first human message now`

    try {
      session.setSteeringMode('all')
      it.send('', interruptKey)
      assert.deepEqual(tui.pendingUserInputs, [], 'Idle empty Alt+Enter is a no-op')
      it.send('start', '\r')
      it.replies.push([block.call])
      const run = session.prompt(tui.pendingUserInputs.shift()!)
      await block.started()

      // Same text, different owners: the extension steer stays; the human steer moves.
      await session.sendUserMessage('DUPLICATE', { deliverAs: 'steer' })
      await it.submitQueued('DUPLICATE', '\r')
      await it.submitQueued('/steer SLASH_STEER', '\r')
      await session.sendCustomMessage(
        { customType: 'board', content: 'HIDDEN_EVENT', display: false },
        { deliverAs: 'followUp' },
      )
      await session.sendUserMessage('EXTENSION_FOLLOW_UP', { deliverAs: 'followUp' })
      assert.equal(it.panel().split(hint).length, 2, 'One truthful interrupt hint')
      assert.equal(session.agent.signal?.aborted, false, 'Enter and /steer never cancel')
      const [extension, human, slash] = it.steeringQueue()
      assert.ok(extension && human && slash)

      const sameObjects = (expected: AgentMessage[]) => {
        const actual = it.steeringQueue()
        assert.equal(actual.length, expected.length)
        expected.forEach((message, index) => assert.equal(actual[index], message, 'Same object'))
      }
      it.send('', interruptKey)
      assert.equal(session.agent.signal?.aborted, true, 'Cancellation is requested at once')
      sameObjects([extension, slash])
      assert.deepEqual(session.getSteeringMessages(), ['DUPLICATE', 'SLASH_STEER'])
      assert.match(it.panel(), /Interrupting with: DUPLICATE \(waiting for the current/)
      assert.ok(!it.panel().includes(hint), 'No stale push hint while interrupting')
      assert.match(it.chat(), /Interrupt requested; waiting for the current operation to stop/)

      // Repeated keys cannot start a second handoff or consume more input.
      it.send('', interruptKey)
      it.send('KEEP_DRAFT', interruptKey)
      assert.equal(tui.editor.getText(), 'KEEP_DRAFT')
      sameObjects([extension, slash])
      assert.match(it.chat(), /Interrupt already requested/)
      tui.editor.setText('')

      await run
      await it.settledCount(2)
      assert.deepEqual(events, ['block:start', 'block:cancelled'], 'No natural completion')
      assert.deepEqual(it.settled, [
        { aborted: true, pending: true },
        { aborted: false, pending: false },
      ])
      const correction = userTexts(it.requests[1]!)
      assert.equal(correction.at(-1), 'DUPLICATE', 'The correction leads the next turn')
      assert.equal(count(correction, 'DUPLICATE'), 2, 'Extension steer and correction, once each')
      assert.doesNotMatch(it.requests[1]!, /HIDDEN_EVENT|EXTENSION_FOLLOW_UP/)
      const final = userTexts(it.requests.at(-1)!)

      for (const [text, times] of [
        ['start', 1],
        ['DUPLICATE', 2],
        ['SLASH_STEER', 1],
        ['HIDDEN_EVENT', 1],
        ['EXTENSION_FOLLOW_UP', 1],
      ] as const) {
        assert.equal(count(final, text), times, `${text} must arrive ${times} time(s)`)
      }

      assert.equal(it.panel(), '', 'Settlement retires interrupt lines')
      assert.match(it.chat(), /Stopped the current operation; sending your correction/)
    } finally {
      await it.close()
    }

    assert.deepEqual(prototypes(), original)
  },
)

test(
  'typed Alt+Enter waits for an uncooperative tool and then sends the editor text once',
  { timeout: 20_000 },
  async () => {
    const events: string[] = []
    const stubborn = blockingTool('stubborn', false, events)
    const it = await fixture([stubborn])
    const { session, tui } = it

    try {
      it.replies.push([stubborn.call])
      const run = session.prompt('start')
      await stubborn.started()
      it.send('TYPED_FIX', interruptKey)
      assert.equal(tui.editor.getText(), '', 'The editor text became the correction')
      assert.equal(session.agent.signal?.aborted, true)

      for (let turn = 0; turn < 5; turn++) {
        await setImmediate()
      }

      // Requested is not confirmed: the run is still active and no new turn has started.
      assert.equal(session.isStreaming, true)
      assert.equal(it.requests.length, 1)
      assert.equal(it.holder.cancelledRequests, 0)
      assert.match(it.panel(), /Interrupting with: TYPED_FIX \(waiting for the current/)
      assert.doesNotMatch(it.chat(), /Stopped the current operation/)
      it.send('SECOND', interruptKey)
      assert.equal(tui.editor.getText(), 'SECOND', 'A repeated key keeps the new draft')
      assert.match(it.chat(), /Interrupt already requested/)

      stubborn.release()
      await run
      await it.settledCount(2)
      assert.deepEqual(events, ['stubborn:start', 'stubborn:natural'])

      // Only the held correction was pending at the aborted settlement; idle wakers defer to it.
      assert.deepEqual(it.settled, [
        { aborted: true, pending: true },
        { aborted: false, pending: false },
      ])
      assert.equal(it.requests.length, 2)
      const correction = userTexts(it.requests[1]!)
      assert.equal(correction.at(-1), 'TYPED_FIX')
      assert.equal(count(correction, 'TYPED_FIX'), 1)
      assert.equal(count(correction, 'SECOND'), 0)
      assert.equal(tui.editor.getText(), 'SECOND')
      assert.equal(it.panel(), '')
    } finally {
      await it.close()
    }
  },
)

test(
  'closing the session during a requested interrupt returns the correction to the editor',
  { timeout: 20_000 },
  async () => {
    const events: string[] = []
    const stubborn = blockingTool('stubborn', false, events)
    const original = prototypes()
    const it = await fixture([stubborn])
    const { session, tui } = it

    try {
      it.replies.push([stubborn.call])
      const run = session.prompt('start')
      await stubborn.started()
      it.send('CLOSING_FIX', interruptKey)
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      assert.deepEqual(prototypes(), original, 'Shutdown restores Pi while the handoff waits')
      stubborn.release()
      await run
      await it.settledCount(1)

      for (let turn = 0; turn < 5 && !tui.editor.getText(); turn++) {
        await setImmediate()
      }

      assert.equal(tui.editor.getText(), 'CLOSING_FIX')
      assert.equal(it.requests.length, 1, 'A closed session starts no correction turn')
      assert.match(it.chat(), /Could not send your correction: Error: the session closed/)
    } finally {
      await it.close()
    }
  },
)

test(
  'Alt+Enter without human input keeps working; failed deliveries keep the input',
  { timeout: 20_000 },
  async () => {
    const events: string[] = []
    const wait = blockingTool('wait', true, events)
    const it = await fixture([wait])
    const { session, tui } = it
    const prompt = session.prompt.bind(session)
    let failing: string | undefined
    session.prompt = async (text, options) => {
      if (text === failing) {
        throw new Error('Injected prompt failure')
      }

      return prompt(text, options)
    }

    try {
      session.setSteeringMode('all')
      it.replies.push([wait.call])
      let run = session.prompt('start')
      await wait.started()
      await session.sendUserMessage('EXTENSION_ONLY', { deliverAs: 'steer' })
      it.send('', interruptKey)
      assert.equal(session.agent.signal?.aborted, false, 'No human message: no cancellation')
      assert.deepEqual(session.getSteeringMessages(), ['EXTENSION_ONLY'])
      assert.match(it.chat(), /No pending human message; type a correction, then press/)

      // A rejected typed correction returns to the editor ahead of a newer draft.
      failing = 'FAIL_TYPED'
      it.send('FAIL_TYPED', interruptKey)
      tui.editor.setText('NEWER_DRAFT')
      await run
      await it.settledCount(1)

      for (let turn = 0; turn < 5 && tui.editor.getText() === 'NEWER_DRAFT'; turn++) {
        await setImmediate()
      }

      assert.equal(tui.editor.getText(), 'FAIL_TYPED\n\nNEWER_DRAFT')
      assert.match(it.chat(), /Could not send your correction: Error: Injected prompt failure/)
      assert.equal(it.panel(), '')
      assert.deepEqual(events, ['wait:start', 'wait:cancelled'])

      // A rejected pending steer returns to the front of its queue as the same object.
      wait.rearm()
      tui.editor.setText('')
      it.replies.push([wait.call])
      run = session.prompt('again')
      await wait.started()

      // /steer is human input even though Pi submits it through the extension API.
      await it.submitQueued('/steer PENDING_FAIL', '\r')
      assert.equal(it.steeringQueue().length, 1)
      const [pending] = it.steeringQueue()
      failing = 'PENDING_FAIL'
      it.send('', interruptKey)
      assert.equal(session.agent.signal?.aborted, true, 'The /steer message is the correction')
      assert.equal(it.steeringQueue().length, 0)
      await run
      await it.settledCount(2)

      for (let turn = 0; turn < 5 && !session.getSteeringMessages().length; turn++) {
        await setImmediate()
      }

      assert.deepEqual(session.getSteeringMessages(), ['PENDING_FAIL'])
      assert.equal(it.steeringQueue().length, 1)
      assert.equal(it.steeringQueue()[0], pending, 'The original message object returns')
      failing = undefined
      await session.prompt('AFTER')
      const final = userTexts(it.requests.at(-1)!)
      assert.deepEqual(final.slice(-2), ['AFTER', 'PENDING_FAIL'])
      assert.equal(count(final, 'PENDING_FAIL'), 1)
      assert.equal(count(final, 'EXTENSION_ONLY'), 1)
    } finally {
      Reflect.deleteProperty(session, 'prompt')
      await it.close()
    }
  },
)
