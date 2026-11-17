import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { loadRole } from '../src/roles.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-delegation-'))
const store = new StateStore(root)
const jobs = new Delegations(store)
const reports = join(harnessRoot, 'reports', `delegation-${Date.now()}`)
await mkdir(reports, { recursive: true })
await mkdir(join(root, 'design'))
await writeFile(
  join(root, 'design/queue.md'),
  '# Queue design\n\nCapacity and overload behavior remain open.\n\nPersistence is future work.\n',
)
const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(agentDir, 'models-store.json'),
})
const settings = SettingsManager.inMemory({ compaction: { enabled: false } })
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [harness],
})
await loader.reload()
const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  modelRuntime: runtime,
  model: runtime.getModel('openai-codex', 'gpt-6.1-sol')!,
  thinkingLevel: 'medium',
  tools: (await loadRole('orchestrator')).tools,
  resourceLoader: loader,
  settingsManager: settings,
  sessionManager: SessionManager.create(root, join(reports, 'sessions')),
})
await session.bindExtensions({})
const events: unknown[] = []
let requests = 0
let foregroundWrites = 0
session.subscribe((event) => {
  events.push({ at: Date.now(), event })

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    requests++
  }

  if (event.type === 'tool_execution_start' && ['write', 'edit'].includes(event.toolName)) {
    foregroundWrites++
  }
})
console.log(JSON.stringify({ root, reports, state: store.directory }))
const timer = setTimeout(() => {
  void session.abort()
}, 600_000)

try {
  const started = performance.now()
  await session.prompt(
    'We chose capacity 100 and rejection of new jobs when full. Record those decisions in ' +
      'design/queue.md via a subagent, keeping persistence as an open future question. ' +
      'Have that agent get a Fable reviewer to verify the document against these decisions. ' +
      'Continue quizzing me on the next critical decision boundary while that task runs. ' +
      'Keep the document under 150 words and your response concise.',
  )
  const dispatchMs = performance.now() - started
  let job = (await jobs.list()).at(-1)
  assert.ok(job, 'Explicit delegation must start a writable background task')
  assert.equal(job.request.kind, 'documents')
  assert.ok(activeTask(job.state), 'The orchestrator must return before the worker finishes')
  assert.equal(foregroundWrites, 0)
  assert.equal(await store.checkpoint(), undefined)
  console.log(JSON.stringify({ phase: 'discussion-returned', dispatchMs, job: job.request.id }))
  await session.reload()
  const next = performance.now()
  await session.prompt(
    'Continue the quiz with one question and tradeoffs. Leave documents with ' +
      'the background task. Do not start another consultation or task.',
  )
  const discussionMs = performance.now() - next
  await writeFile(join(root, 'independent.md'), '# Independent foreground note\n')
  const before = requests
  const deadline = Date.now() + 600_000

  while (activeTask(job.state) && Date.now() < deadline) {
    await delay(1000)
    job = await jobs.get(job.request.id)
  }

  assert.equal(job.state.status, 'complete', job.state.error)
  await delay(1500)
  assert.equal(requests, before, 'Background completion must not launch a provider turn')
  assert.equal(foregroundWrites, 0)
  assert.equal((await jobs.list()).length, 1)
  assert.ok(job.state.children?.some((child) => child.role === 'task-worker'))
  assert.ok(
    job.state.children?.some(
      (child) =>
        child.role === 'reviewer' &&
        child.model.startsWith('claude-cli/claude-fable-5-2') &&
        child.verdict === 'pass',
    ),
  )
  const document = await readFile(join(root, 'design/queue.md'), 'utf8')
  assert.match(document, /100/)
  assert.match(document, /reject/i)
  assert.match(document, /persist/i)
  assert.equal(
    await readFile(join(root, 'independent.md'), 'utf8'),
    '# Independent foreground note\n',
  )
  const delivered = () =>
    session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
      .length
  assert.equal(delivered(), 1)
  await session.reload()
  await delay(1200)
  assert.equal(delivered(), 1)
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    dispatchMs,
    discussionMs,
    elapsedMs: performance.now() - started,
    foregroundWrites,
    requests,
    document,
    task: job.state,
  })
  console.log(JSON.stringify({ status: 'passed', reports, dispatchMs, discussionMs }))
} finally {
  clearTimeout(timer)

  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  await writeFile(
    join(reports, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  session.dispose()
  await runtime.settleCredentialWrites()
}
