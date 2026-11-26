import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  initTheme,
  InteractiveMode,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionEvent,
  type CustomEditor,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { registerActivityCaption } from '../src/activity-caption.ts'
import { fileURLToPath } from 'node:url'
import { captureSession } from './session-support.ts'

// Mount the production Pi editor, input actions, extension UI and chat renderer. Only terminal
// output and the CLI's outer idle-input loop are disconnected. No provider credentials or sleeps.
function editorFor(session: AgentSession) {
  initTheme('dark', false)
  const host = { session, setRebindSession() {}, setBeforeSessionInvalidate() {} }
  const tui = new InteractiveMode(host as AgentSessionRuntime) as unknown as {
    editor: CustomEditor
    chatContainer: Component
    ui: { requestRender(): void }
    setupKeyHandlers(): void
    setupEditorSubmitHandler(): void
    isInitialized: boolean
    handleEvent(event: AgentSessionEvent): Promise<void>
    clearStatusIndicator(): void
    createExtensionUIContext(): ExtensionUIContext
    addMessageToChat(message: AssistantMessage): void
    pendingUserInputs: string[]
  }
  tui.isInitialized = true
  tui.ui.requestRender = () => {}
  tui.setupKeyHandlers()
  tui.setupEditorSubmitHandler()
  return tui
}

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, promise }
}

test(
  'Enter steers; empty follow-up key promotes one editor message without dropping work',
  {
    timeout: 20_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-host-input-'))
    const started = latch()
    const proceed = latch()
    const requests: string[] = []
    const { session, runtime } = await captureSession(
      root,
      root,
      [],
      async (ctx) => {
        requests.push(JSON.stringify(ctx.messages))

        if (requests.length === 1) {
          started.release()
          await proceed.promise
          return ['one', 'two'].map((path) => ({
            type: 'toolCall',
            id: path,
            name: 'write',
            arguments: { path, content: path },
          }))
        }

        return [{ type: 'text', text: 'Done' }]
      },
      { extensionPaths: [fileURLToPath(new URL('../src/steering.ts', import.meta.url))] },
    )
    const tui = editorFor(session)
    const originalEnqueue = session.agent.followUp
    const originalAction = Reflect.get(InteractiveMode.prototype, 'handleFollowUp')
    const send = (text: string, key: string) => {
      tui.editor.setText(text)
      tui.editor.handleInput(key)
    }
    const queued = () => {
      const done = latch()
      const off = session.subscribe((event) => {
        if (event.type === 'queue_update') {
          off()
          done.release()
        }
      })
      return done.promise
    }

    try {
      await session.bindExtensions({ mode: 'tui', uiContext: tui.createExtensionUIContext() })
      send('', '\x1b\r')
      assert.deepEqual(tui.pendingUserInputs, [])
      send('start', '\r')
      assert.deepEqual(tui.pendingUserInputs, ['start'])
      session.setSteeringMode('all')
      const run = session.prompt(tui.pendingUserInputs.shift()!)
      await started.promise
      await session.sendCustomMessage(
        { customType: 'board', content: 'BOARD_EVENT', display: true },
        {
          deliverAs: 'followUp',
          triggerTurn: true,
        },
      )

      // Same text, different owner: a push must move the editor object, not the first match.
      await session.sendUserMessage('PUSH_ME', { deliverAs: 'followUp' })
      await session.sendUserMessage('EXTENSION_FOLLOW_UP', { deliverAs: 'followUp' })

      for (const [text, key] of [
        ['ENTER_STEER', '\r'],
        ['/steer SLASH_STEER', '\r'],
        ['PUSH_ME', '\x1b\r'],
        ['KEEP_LATER', '\x1b\r'],
      ] as const) {
        const waiting = queued()
        send(text, key)
        await waiting
      }

      send('', '\x1b\r')
      assert.deepEqual(session.getSteeringMessages(), ['ENTER_STEER', 'SLASH_STEER', 'PUSH_ME'])
      assert.deepEqual(session.getFollowUpMessages(), [
        'PUSH_ME',
        'EXTENSION_FOLLOW_UP',
        'KEEP_LATER',
      ])
      assert.equal(requests.length, 1)
      proceed.release()
      await run
      assert.match(requests[1]!, /ENTER_STEER/)
      assert.equal(requests[1]!.split('PUSH_ME').length, 2)
      assert.match(requests[1]!, /"toolCallId":"one"/)
      assert.match(requests[1]!, /"toolCallId":"two"/)
      assert.doesNotMatch(requests[1]!, /KEEP_LATER|BOARD_EVENT|EXTENSION_FOLLOW_UP/)

      for (const path of ['one', 'two']) {
        assert.equal(await readFile(join(root, path), 'utf8'), path)
      }

      assert.equal(requests.at(-1)!.split('PUSH_ME').length, 3)
      send('', '\x1b\r')
      assert.equal(tui.pendingUserInputs.length, 0)

      for (const text of [
        'ENTER_STEER',
        'SLASH_STEER',
        'KEEP_LATER',
        'BOARD_EVENT',
        'EXTENSION_FOLLOW_UP',
      ]) {
        assert.equal(requests.at(-1)!.split(text).length, 2, text + ' must arrive exactly once')
      }
    } finally {
      proceed.release()
      await session.abort()
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      assert.equal(session.agent.followUp, originalEnqueue)
      assert.equal(Reflect.get(InteractiveMode.prototype, 'handleFollowUp'), originalAction)
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('assistant and editor render one replaceable plain caption, then clear it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-host-caption-'))
  const { session, runtime } = await captureSession(
    root,
    root,
    [registerActivityCaption],
    async () => [],
  )
  session.settingsManager.setHideThinkingBlock(true)
  session.settingsManager.setShowTerminalProgress(false)
  const tui = editorFor(session)
  const runner = session.extensionRunner
  const partial: AssistantMessage = {
    role: 'assistant',
    api: 'openai-completions',
    model: 'capture',
    provider: 'capture',
    timestamp: 1,
    stopReason: 'stop',
    content: [],
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }

  try {
    await session.bindExtensions({ mode: 'tui', uiContext: tui.createExtensionUIContext() })
    const idle = tui.editor.render(72).join('\n')
    await tui.handleEvent({ type: 'turn_start' })
    await tui.handleEvent({ type: 'message_start', message: partial })

    for (const word of ['FIRST', 'SECOND', 'THIRD', 'FOURTH']) {
      const thinking = `Earlier line\n\n\x1b[1;3m**${word}**\x1b[0m`
      const contentIndex = partial.content.push({ type: 'thinking', thinking }) - 1
      const event = {
        type: 'message_update' as const,
        message: partial,
        assistantMessageEvent: {
          type: 'thinking_delta' as const,
          contentIndex,
          delta: thinking,
          partial,
        },
      }
      await runner.emit(event)
      await tui.handleEvent(event)

      for (const width of [16, 72]) {
        assert.equal(tui.chatContainer.render(width).length, 0, 'No hidden labels or spacers')
        const lines = tui.editor.render(width)
        const captions = lines.filter((line) => /FIRST|SECOND|THIRD|FOURTH/.test(line))
        assert.equal(captions.length, 1)
        assert.ok(stripTerminalSequences(captions[0]!).includes(word))

        for (const style of ['Earlier', '**', '\x1b[1;3m', '\x1b[1m', '\x1b[3m']) {
          assert.ok(!captions[0]!.includes(style))
        }

        assert.ok(visibleWidth(captions[0]!) <= width)
      }
    }

    tui.addMessageToChat({
      ...partial,
      content: [...partial.content, { type: 'text', text: 'Answer' }],
      stopReason: 'error',
      errorMessage: 'Fixture error',
    })
    const chat = stripTerminalSequences(tui.chatContainer.render(72).join('\n'))
    assert.match(chat, /Answer/)
    assert.match(chat, /Fixture error/)
    assert.doesNotMatch(chat, /FIRST|SECOND|THIRD|FOURTH/)
    await runner.emit({ type: 'agent_end', messages: [partial] })
    await tui.handleEvent({ type: 'agent_end', messages: [partial], willRetry: false })
    assert.equal(tui.editor.render(72).join('\n'), idle)
    await tui.handleEvent({ type: 'turn_start' })
    assert.doesNotMatch(tui.editor.render(72).join('\n'), /FOURTH/)
    await runner.emit({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'thinking_end',
        contentIndex: 3,
        content: 'FOURTH',
        partial,
      },
    })
    assert.match(tui.editor.render(72).join('\n'), /FOURTH/)
    await runner.emit({ type: 'session_shutdown', reason: 'reload' })
    assert.doesNotMatch(tui.editor.render(72).join('\n'), /FOURTH/)
  } finally {
    tui.clearStatusIndicator()
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(root, { recursive: true, force: true })
  }
})
