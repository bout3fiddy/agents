import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import harness from '../src/extension.ts'
import { harnessRoot } from '../src/project.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { loadRole } from '../src/roles.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-workshop-'))
const store = new StateStore(root)
const reports = join(harnessRoot, 'reports', `workshop-${Date.now()}`)
await mkdir(reports, { recursive: true })
await writeFile(
  join(root, 'requirements.md'),
  '# Workshop\n\nDesign a bounded in-memory task queue. Persistence is an open future decision.\n',
)
const hash = await store.draft({
  objective: 'Workshop the task queue and record user decisions in design/design.md',
  design: 'Discuss capacity and overload behavior; document open questions.',
  invariants: ['Bound retained jobs'],
  acceptance: ['The document distinguishes decisions from open questions'],
  writePaths: ['design/design.md'],
  database: false,
  performance: false,
  unresolved: ['Should a later version persist jobs?'],
})
await store.accept(hash)
const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(agentDir, 'models-store.json'),
})
const model = modelRuntime.getModel('openai-codex', 'gpt-6.1-sol')
assert.ok(model)
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
const resourceLoader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [harness],
})
await resourceLoader.reload()
const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  modelRuntime,
  model,
  thinkingLevel: 'medium',
  tools: (await loadRole('orchestrator')).tools,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.create(root, join(reports, 'sessions')),
})
await session.bindExtensions({})
const events: unknown[] = []
let receivedAdvice = false
let ownResponseBeforeAdvice = false
let consultationStarted = false
let resolveAdvice!: () => void
let rejectAdvice!: (error: Error) => void
const advised = new Promise<void>((resolve, reject) => {
  resolveAdvice = resolve
  rejectAdvice = reject
})
advised.catch(() => {})
const timer = setTimeout(() => rejectAdvice(new Error('Workshop live run timed out')), 360000)
session.subscribe((event) => {
  events.push({ at: Date.now(), event })

  if (event.type === 'tool_execution_end' && event.toolName === 'consult_design') {
    consultationStarted = !event.isError
  }

  if (event.type === 'message_end') {
    if (event.message.role === 'custom' && event.message.customType === 'pi-design-advice') {
      receivedAdvice = true
    }

    if (
      event.message.role === 'assistant' &&
      consultationStarted &&
      !receivedAdvice &&
      event.message.content.some((part) => part.type === 'text' && part.text.length > 100)
    ) {
      ownResponseBeforeAdvice = true
    }
  }

  if (event.type === 'agent_end' && receivedAdvice) {
    resolveAdvice()
  }
})
console.log(JSON.stringify({ root, state: store.directory, reports }))

try {
  await session.prompt(
    'Read requirements.md. Workshop whether overload should reject new jobs or evict old ones. ' +
      'Start parallel Fable advice and give your own Codex recommendation while it runs. ' +
      'Also use bash to run pwd to verify shell access. Keep guidance under 150 words. ' +
      'Wait for my choice before editing design documents. Do not call implementation workflow.',
  )
  await advised
  await session.waitForIdle()
  assert.ok(consultationStarted)
  assert.ok(ownResponseBeforeAdvice, 'Codex should offer its own view while Fable is running')
  await session.prompt(
    'Choose capacity 100 and reject new jobs when full. Commit that update to design/design.md ' +
      'directly, retaining persistence as an open future question. This means save the file. ' +
      'Do not make a Git commit or spawn an implementation worker. ' +
      'Keep the document under 200 words.',
  )
  await session.waitForIdle()
  const document = await readFile(join(root, 'design/design.md'), 'utf8')
  assert.match(document, /100/)
  assert.match(document, /reject/i)
  assert.match(document, /persist/i)
  assert.equal((await store.checkpoint())?.version, 1)
  assert.equal(await store.task(), undefined)
  assert.match(store.directory, /\.pi\/traces\/harness$/)
  assert.match(await readFile(join(root, '.pi/.gitignore'), 'utf8'), /\/traces\//)
  const localSessions = await readdir(join(root, '.pi/traces/sessions'))
  assert.equal(localSessions.filter((name) => name.endsWith('.jsonl')).length, 1)
  const transcript = JSON.stringify(events)
  assert.match(transcript, /"toolName":"bash"/)
  assert.match(transcript, /claude-cli\/claude-fable-5-2/)
  assert.doesNotMatch(transcript, /"toolName":"(?:workflow|propose_design)"/)
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    state: store.directory,
    ownResponseBeforeAdvice,
    receivedAdvice,
    document,
    acceptedVersion: 1,
    implementationWorkers: 0,
  })
  console.log(JSON.stringify({ status: 'passed', reports, ownResponseBeforeAdvice }))
} finally {
  clearTimeout(timer)
  await writeFile(
    join(reports, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  session.dispose()
  await modelRuntime.settleCredentialWrites()
}
