import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import harness from '../src/extension.ts'
import { harnessRoot } from '../src/project.ts'
import { loadRole } from '../src/roles.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { WorkersCatalog, type WorkerRow } from '../src/workers-data.ts'
import { WorkersView } from '../src/workers-ui.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-workers-'))
const reports = join(harnessRoot, 'reports', `workers-${Date.now()}`)
await mkdir(reports, { recursive: true })
await mkdir(join(root, 'design'))
await writeFile(join(root, 'design/queue.md'), '# Queue\n\nCapacity is undecided.\n')
const store = new StateStore(root)
const jobs = new Delegations(store)
const catalog = new WorkersCatalog(root)
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
await session.bindExtensions({
  onError: (error) => {
    throw new Error(JSON.stringify(error))
  },
})
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme
const view = new WorkersView(
  catalog,
  theme,
  () => 30,
  () => {},
  () => {},
  false,
  false,
)
const deadline = Date.now() + 600000
const events: unknown[] = []
session.subscribe((event) => {
  events.push(event)
})
console.log(JSON.stringify({ root, reports }))

async function waitWorker(role: string): Promise<WorkerRow> {
  while (Date.now() < deadline) {
    const row = (await catalog.list()).find((item) => item.active && item.info.role === role)

    if (row) {
      return row
    }

    const job = (await jobs.list())[0]

    if (job && !activeTask(job.state)) {
      throw new Error(JSON.stringify(job.state))
    }

    await delay(200)
  }

  throw new Error(`Live worker did not start: ${role}`)
}

async function guide(row: WorkerRow, text: string): Promise<void> {
  await view.refresh()
  view.selectedId = row.id
  view.handleInput('\r')
  await view.refresh()
  view.handleInput('d')
  assert.match(view.render(100).join('\n'), /Worker:|Repository/)
  view.handleInput('d')
  view.handleInput('g')
  view.input.setValue(text)
  view.handleInput('\r')

  while (Date.now() < deadline) {
    await view.refresh()
    const updated = view.rows.find((item) => item.id === row.id)

    if (updated?.guidance.some((message) => message.text === text)) {
      break
    }

    await delay(100)
  }

  assert.ok(
    view.rows.find((item) => item.id === row.id)?.guidance.some((message) => message.text === text),
  )
  view.handleInput('\x1b')
  view.handleInput('\x1b')
}

try {
  const started = performance.now()
  await session.prompt(
    'Delegate a small document task in the background, then keep discussing with me. ' +
      'Record capacity 100 and reject new jobs when full in design/queue.md; keep persistence ' +
      'open. Use one task-worker, then the explicitly requested independent Fable reviewer. ' +
      'Tell the editing worker to report_progress with a brief summary, then run_command ' +
      'node -e "setTimeout(() => {}, 20000)" once before editing. ' +
      'It may receive guidance while waiting. The reviewer should independently check ' +
      'the final current decisions, and also run that 20-second command once before its verdict. ' +
      'Keep the document below 100 words. No other files, commits or publication. ' +
      'Return to this discussion immediately after dispatch.',
  )
  const dispatchMs = performance.now() - started
  const worker = await waitWorker('task-worker')
  await guide(
    worker,
    'Update from the user: use capacity 120 instead of 100. ' +
      'Keep rejection when full and persistence open. Finish the same task; do not restart work.',
  )
  const discussionStart = performance.now()
  await session.prompt('While the worker continues, explain the overload tradeoff in one sentence.')
  const discussionMs = performance.now() - discussionStart
  const reviewer = await waitWorker('reviewer')
  await guide(
    reviewer,
    'Review the final capacity 120 decision and rejection when full. ' +
      'Keep persistence open. Include REVIEW GUIDANCE RECEIVED in your final summary. ' +
      'This is guidance for the current review; do not ask for another review.',
  )
  let job = (await jobs.list())[0]!

  while (activeTask(job.state) && Date.now() < deadline) {
    await delay(500)
    job = await jobs.get(job.request.id)
  }

  assert.equal(job.state.status, 'complete', job.state.error)
  const document = await readFile(join(root, 'design/queue.md'), 'utf8')
  assert.match(document, /120/)
  assert.doesNotMatch(document, /100/)
  const rows = await catalog.list()

  for (const target of [worker, reviewer]) {
    const row = rows.find((item) => item.id === target.id)!
    assert.equal(row.active, false)
    assert.equal(row.guidance[0]?.status, 'delivered')
  }

  assert.match(
    rows.find((item) => item.id === reviewer.id)!.state.summary!,
    /REVIEW GUIDANCE RECEIVED/,
  )
  await view.refresh()
  view.activeTab = false
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    dispatchMs,
    discussionMs,
    elapsedMs: performance.now() - started,
    document,
    task: job.state,
    workers: rows.map((row) => ({ info: row.info, state: row.state, guidance: row.guidance })),
    pastView: view.render(100),
  })
  console.log(JSON.stringify({ status: 'passed', reports, dispatchMs, discussionMs }))
} finally {
  view.dispose()

  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  await writeFile(
    join(reports, 'host-events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  session.dispose()
  await runtime.settleCredentialWrites()
}
