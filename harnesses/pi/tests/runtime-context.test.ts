import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
import { loadRole } from '../src/roles.ts'

test('scope snapshots preserve Pi conversation lifecycle', async () => {
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
  manager.appendMessage({
    role: 'user',
    content: 'EARLY_USER_CONSTRAINT',
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

    // A pre-upgrade checkpoint must no longer hide earlier conversation on reload.
    await store.draft({ ...design, design: 'FINAL_SCHEMA_MARKER' })
    await store.accept()
    session = await create(manager)
    const sessionFile = manager.getSessionFile()!
    assert.equal(session.extensionRunner.getCommand('accept-design'), undefined)
    assert.ok(!session.getActiveToolNames().includes('propose_design'))
    await session.prompt('PENDING_CONSTRAINT_MARKER')
    assert.match(payloads.at(-1)!, /FINAL_SCHEMA_MARKER/)
    assert.match(payloads.at(-1)!, /EARLY_USER_CONSTRAINT/)
    const earlierBranch = session.sessionManager.getLeafId()!
    await store.pin({ ...design, design: 'UPDATED_SCHEMA_MARKER' })
    await session.prompt('Continue our discussion after recording the implementation scope')
    assert.match(payloads.at(-1)!, /UPDATED_SCHEMA_MARKER/)
    assert.match(payloads.at(-1)!, /EARLY_USER_CONSTRAINT/)
    assert.match(payloads.at(-1)!, /PENDING_CONSTRAINT_MARKER/)
    assert.equal(manager.getSessionFile(), sessionFile)
    assert.equal(replacements, 0)
    const beforeCompact = payloads.length
    await session.compact()
    assert.ok(payloads.length > beforeCompact, 'Native Pi compaction must reach its summarizer')
    assert.match(payloads.slice(beforeCompact).join('\n'), /EARLY_USER_CONSTRAINT/)
    assert.match(payloads.slice(beforeCompact).join('\n'), /PENDING_CONSTRAINT_MARKER/)
    await session.prompt('Continue after compaction')
    assert.match(payloads.at(-1)!, /UPDATED_SCHEMA_MARKER/)
    const mirror = await readFile(
      join(item.root, '.pi/traces/sessions', basename(sessionFile)),
      'utf8',
    )
    assert.match(mirror, /PENDING_CONSTRAINT_MARKER/)
    session.dispose()
    session = await create(SessionManager.open(sessionFile))
    await session.prompt('Continue after resume')
    assert.match(payloads.at(-1)!, /UPDATED_SCHEMA_MARKER/)
    await session.navigateTree(earlierBranch, { summarize: true })
    await session.prompt('Continue after navigating the earlier branch')
    assert.match(payloads.at(-1)!, /EARLY_USER_CONSTRAINT/)
    assert.match(payloads.at(-1)!, /UPDATED_SCHEMA_MARKER/)
    assert.deepEqual(
      session.getActiveToolNames().sort(),
      (await loadRole('orchestrator')).tools.sort(),
    )
    assert.equal(replacements, 0)
  } finally {
    session?.dispose()
    await modelRuntime.settleCredentialWrites()
    await rm(store.directory, { recursive: true, force: true })
    await rm(item.base, { recursive: true, force: true })
  }
})
