import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import harness from '../src/extension.ts'
import { StateStore } from '../src/state.ts'
import { fixture, design } from './support.ts'

test('Pi excludes rejected designs across context lifecycle changes', async () => {
  const item = await fixture()
  const store = new StateStore(item.root)
  const payloads: string[] = []
  const modelRuntime = await ModelRuntime.create({
    authPath: join(item.base, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(item.base, 'catalog.json'),
    refreshOnCreate: false,
  })
  modelRuntime.registerProvider('capture', {
    api: 'openai-completions',
    baseUrl: 'http://unused',
    apiKey: 'test-only',
    models: [
      {
        id: 'capture',
        name: 'Capture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context) {
      payloads.push(JSON.stringify(context))
      const stream = new AssistantMessageEventStream()
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: 'text', text: 'acknowledged' }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'done', reason: 'stop', message })
      stream.end()
      return stream
    },
  })
  const manager = SessionManager.create(item.root, join(item.base, 'sessions'))
  const oldEntry = manager.appendMessage({
    role: 'user',
    content: 'REJECTED_SCHEMA_MARKER',
    timestamp: Date.now() - 10000,
  })
  let session: AgentSession | undefined
  let replacements = 0

  async function create(sessionManager: SessionManager) {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 },
    })
    const loader = new DefaultResourceLoader({
      cwd: item.root,
      agentDir: item.base,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [harness],
    })
    await loader.reload()
    const { session: created } = await createAgentSession({
      cwd: item.root,
      agentDir: item.base,
      modelRuntime,
      model: modelRuntime.getModel('capture', 'capture')!,
      resourceLoader: loader,
      settingsManager,
      sessionManager,
    })
    const unsupported = async () => {
      throw new Error('Unexpected session operation')
    }
    await created.bindExtensions({
      commandContextActions: {
        waitForIdle: () => created.waitForIdle(),
        newSession: async (options) => {
          replacements++
          sessionManager.newSession({ parentSession: options?.parentSession })
          await options?.setup?.(sessionManager)
          return { cancelled: false }
        },
        fork: unsupported,
        navigateTree: unsupported,
        switchSession: unsupported,
        reload: unsupported,
      },
    })
    return created
  }

  try {
    await store.draft({ ...design, design: 'FINAL_SCHEMA_MARKER' })
    await store.accept()
    session = await create(manager)
    await session.prompt('PENDING_CONSTRAINT_MARKER')
    assert.match(payloads.at(-1)!, /FINAL_SCHEMA_MARKER/)
    assert.doesNotMatch(payloads.at(-1)!, /REJECTED_SCHEMA_MARKER/)
    await session.compact()
    await session.prompt('Continue after compaction')
    assert.match(payloads.at(-1)!, /PENDING_CONSTRAINT_MARKER/)
    assert.doesNotMatch(payloads.at(-1)!, /REJECTED_SCHEMA_MARKER/)
    const sessionFile = manager.getSessionFile()!
    session.dispose()
    session = await create(SessionManager.open(sessionFile))
    await session.prompt('Continue after resume')
    assert.match(payloads.at(-1)!, /PENDING_CONSTRAINT_MARKER/)
    assert.doesNotMatch(payloads.at(-1)!, /REJECTED_SCHEMA_MARKER/)
    await session.navigateTree(oldEntry, { summarize: true })
    await session.prompt('Continue after navigating the old branch')
    assert.match(payloads.at(-1)!, /FINAL_SCHEMA_MARKER/)
    assert.doesNotMatch(payloads.at(-1)!, /REJECTED_SCHEMA_MARKER/)
    assert.deepEqual(session.getActiveToolNames().sort(), [
      'harness_status',
      'project_read',
      'project_search',
      'propose_design',
      'workflow',
    ])
    const originalVersion = (await store.checkpoint())!.version
    const nextHash = await store.draft({ ...design, design: 'UPDATED_SCHEMA_MARKER' })
    await session.prompt('/accept-design')
    assert.equal((await store.checkpoint())!.version, originalVersion)
    await session.followUp('QUEUED_INPUT_MARKER')
    await session.prompt(`/accept-design ${nextHash}`)
    assert.equal((await store.checkpoint())!.version, originalVersion)
    assert.equal(replacements, 0)
    assert.equal(session.clearQueue().followUp.length, 1)
    await session.prompt(`/accept-design ${nextHash}`)
    assert.equal((await store.checkpoint())!.version, originalVersion + 1)
    assert.equal(replacements, 1)
    const seed = JSON.stringify(session.sessionManager.getBranch())
    assert.match(seed, /UPDATED_SCHEMA_MARKER/)
    assert.doesNotMatch(seed, /REJECTED_SCHEMA_MARKER|PENDING_CONSTRAINT_MARKER/)
  } finally {
    session?.dispose()
    await modelRuntime.settleCredentialWrites()
    await rm(store.directory, { recursive: true, force: true })
    await rm(item.base, { recursive: true, force: true })
  }
})
