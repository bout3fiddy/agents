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
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(tmpdir(), 'pi-live-workshop-'))
const store = new StateStore(root)
const reports = join(harnessRoot, 'reports', `workshop-${Date.now()}`)
await mkdir(reports, { recursive: true })
await writeFile(
  join(root, 'requirements.md'),
  '# Workshop\n\nDesign a bounded in-memory task queue. Persistence is an open future decision.\n',
)
await writeFile(
  join(root, 'reference.md'),
  '# Context fixture\n\nCURRENT_READ_SENTINEL\n\n' +
    'Repeated reference material for the context retention test.\n'.repeat(600),
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
await session.bindExtensions({
  onError: (error) => {
    throw new Error(JSON.stringify(error))
  },
})
const events: unknown[] = []
let receivedAdvice = false
let ownResponseBeforeAdvice = false
let consultationStarted = false
let consultationCount = 0
let modelSteps = 0
let documentChecks = 0
const measurements: {
  scenario: string
  elapsedMs: number
  steps: number
  consultations: number
}[] = []
let resolveAdvice!: () => void
let rejectAdvice!: (error: Error) => void
const advised = new Promise<void>((resolve, reject) => {
  resolveAdvice = resolve
  rejectAdvice = reject
})
advised.catch(() => {})
const timer = setTimeout(() => {
  rejectAdvice(new Error('Workshop live run timed out'))
  void session.abort()
}, 600000)
session.subscribe((event) => {
  events.push({ at: Date.now(), event })

  if (
    event.type === 'entry_appended' &&
    event.entry.type === 'custom_message' &&
    event.entry.customType === 'pi-design-advice'
  ) {
    receivedAdvice = true
  }

  if (event.type === 'tool_execution_end' && event.toolName === 'consult_design') {
    consultationStarted = !event.isError
    consultationCount++
  }

  if (event.type === 'tool_execution_end' && event.toolName === 'document_check') {
    documentChecks++
  }

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    modelSteps++
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

async function measure(scenario: string, prompt: string) {
  const start = performance.now()
  const before = { steps: modelSteps, consultations: consultationCount }
  await session.prompt(prompt)
  await session.waitForIdle()
  const result = {
    scenario,
    elapsedMs: performance.now() - start,
    steps: modelSteps - before.steps,
    consultations: consultationCount - before.consultations,
  }
  measurements.push(result)
  console.log(JSON.stringify(result))
  return result
}

try {
  await measure(
    'substantive design',
    'Read requirements.md. Workshop whether overload should reject new jobs or evict old ones. ' +
      'Start parallel Fable advice and give your own Codex recommendation while it runs. ' +
      'Also use bash to run pwd to verify shell access. Keep guidance under 150 words. ' +
      'Read reference.md once; it is a context-retention fixture and should not go to Fable. ' +
      'Wait for my choice before editing design documents. Do not call implementation workflow.',
  )
  await advised
  await session.waitForIdle()
  assert.ok(consultationStarted)
  assert.ok(ownResponseBeforeAdvice, 'Codex should offer its own view while Fable is running')
  const consultations = consultationCount
  const edit = await measure(
    'record settled choice',
    'Choose capacity 100 and reject new jobs when full. Commit that update to design/design.md ' +
      'directly, retaining persistence as an open future question. This means save the file. ' +
      'Do not make a Git commit or spawn an implementation worker. ' +
      'Keep the document under 200 words.',
  )
  assert.equal(edit.consultations, 0, 'Recording a settled choice needs no new consultation')
  assert.ok(edit.steps <= 8, 'Document editing should finish in a bounded coherent pass')
  const document = await readFile(join(root, 'design/design.md'), 'utf8')
  assert.match(document, /100/)
  assert.match(document, /reject/i)
  assert.match(document, /persist/i)
  const quiz = await measure(
    'quiz format',
    'Resolve the remaining choices as a one-question-at-a-time quiz, with options and tradeoffs. ' +
      'Do not update documents until all questions have been answered.',
  )
  assert.equal(quiz.consultations, 0, 'Quiz presentation should reuse the existing design advice')
  assert.equal(await readFile(join(root, 'design/design.md'), 'utf8'), document)
  const split = await measure(
    'mechanical document split',
    'Pause the quiz. Split the existing design document into design/capacity.md and ' +
      'design/persistence.md, with design/design.md as a short index. Preserve existing choices ' +
      'and open questions; this is only document organization. Keep all three concise.',
  )
  assert.equal(split.consultations, 0)
  assert.ok(split.steps <= 10, 'A small document split should not become a prolonged edit loop')
  assert.ok(documentChecks >= 1, 'Use the executable document checker for the quick local edit')
  const jobs = new Delegations(store)
  let job = (await jobs.list()).at(-1)
  assert.ok(job, 'A multi-file document split must delegate automatically')
  const deadline = Date.now() + 600_000

  while (activeTask(job.state) && Date.now() < deadline) {
    await delay(1000)
    job = await jobs.get(job.request.id)
  }

  assert.equal(job.state.status, 'complete', job.state.error)
  await delay(1200)
  await session.waitForIdle()
  assert.equal(consultationCount, consultations)
  assert.ok(
    session.sessionManager.getBranch().some((entry) => entry.type === 'context_edit'),
    'The real provider must accept requests after historical tool payloads are excerpted',
  )
  const consultationFiles = (await readdir(join(store.directory, 'consultations'))).filter(
    (name) => name.endsWith('.json') && !name.endsWith('.input.json'),
  )
  const advice = JSON.parse(
    await readFile(join(store.directory, 'consultations', consultationFiles[0]!), 'utf8'),
  )
  const adviceWords = advice.advice.text.split(/\s+/).length
  assert.ok(adviceWords <= 500, `Brief consultation exceeded budget: ${adviceWords} words`)
  assert.equal((await store.checkpoint())?.version, 1)
  assert.equal(await store.task(), undefined)
  assert.match(store.directory, /\.pi\/traces\/harness$/)
  assert.match(await readFile(join(root, '.pi/.gitignore'), 'utf8'), /\/traces\//)
  const localSessions = await readdir(join(root, '.pi/traces/sessions'))
  assert.equal(localSessions.filter((name) => name.endsWith('.jsonl')).length, 1)
  const transcript = JSON.stringify(events)
  assert.match(transcript, /"toolName":"bash"/)
  assert.match(transcript, /claude-cli\/(?:claude-fable-5-2|(?:claude-)?opus)\b/)
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
    measurements,
    consultationCount,
    adviceWords,
    documentChecks,
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
