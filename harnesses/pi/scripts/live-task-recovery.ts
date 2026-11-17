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
import { StateStore, atomicJson, readJson } from '../src/state.ts'
import {
  Delegations,
  activeTask,
  delegationDirectory,
  type Delegation,
  type TaskControls,
} from '../src/delegation-state.ts'
import { launchDelegation } from '../src/delegation-process.ts'
import { loadRole } from '../src/roles.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-recovery-'))
const reports = join(harnessRoot, 'reports', `task-recovery-${Date.now()}`)
await mkdir(reports, { recursive: true })

for (const name of ['a', 'b']) {
  await writeFile(join(root, `${name}.md`), `# ${name.toUpperCase()}\n\nPending.\n`)
}

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
  onError(error) {
    throw new Error(JSON.stringify(error))
  },
})
const calls: string[] = []
session.subscribe((event) => {
  if (event.type === 'tool_execution_start') {
    calls.push(event.toolName)
  }
})
const jobs = new Delegations(new StateStore(root))
const origin = {
  session: session.sessionManager.getSessionId(),
  model: 'openai-codex/gpt-6.1-sol',
}
console.log(JSON.stringify({ root, reports }))
const started = performance.now()

async function waitFor(ids: string[], ready: (tasks: Delegation[]) => Promise<boolean>) {
  const deadline = Date.now() + 360000

  while (Date.now() < deadline) {
    const tasks = await Promise.all(ids.map((id) => jobs.get(id)))

    if (await ready(tasks)) {
      return tasks
    }

    assert.ok(
      tasks.every(
        (task) => !['failed', 'needs_attention', 'cancelled'].includes(task.state.status),
      ),
      JSON.stringify(tasks.map((task) => task.state)),
    )
    await delay(300)
  }

  throw new Error('Live validation deadline exceeded')
}

try {
  const tasks: Delegation[] = []

  for (const name of ['a', 'b']) {
    tasks.push(
      await jobs.start(
        {
          task:
            `Delegate a task-worker to change only Pending. to Draft. in ${name}.md. ` +
            'After retaining that edit, the child must run the following slow check before ' +
            'returning: node -e "setTimeout(()=>console.log(\'checked\'), 90000)". ' +
            'Use command timeoutMs 120000. This deliberate slow check tests cancellation. ' +
            'Keep the worker running until the check completes. No specialist review.',
          context: 'Validation fixture. Preserve the title and all other files.',
          kind: 'documents',
          writePaths: [`${name}.md`],
        },
        origin,
        launchDelegation,
      ),
    )
  }

  const ids = tasks.map((task) => task.request.id)
  const running = await waitFor(ids, async (current) => {
    const contents = await Promise.all(
      current.map(async (task, index) => {
        if (!task.state.candidate) {
          return ''
        }

        return readFile(join(task.state.candidate, `${index ? 'b' : 'a'}.md`), 'utf8')
      }),
    )
    return contents.every((content) => content.includes('Draft.'))
  })

  for (const task of tasks) {
    await jobs.control(task.request.id, 'message', 'Preserve the original file title.')
  }

  await session.prompt(
    'Pause both background tasks now so we can revise ownership. ' +
      'Keep them paused until I explicitly request resume. Do not cancel or edit their files. ' +
      `IDs: ${ids.join(', ')}. While they stop, explain why a single writer per file helps.`,
  )
  const stopped = await waitFor(ids, async (current) =>
    current.every((task) => task.state.status === 'paused'),
  )
  assert.equal(calls.filter((name) => name === 'task_control').length, 2)

  for (const [index, task] of stopped.entries()) {
    assert.equal(task.state.candidate, running[index]!.state.candidate)
    assert.match(await readFile(join(root, `${index ? 'b' : 'a'}.md`), 'utf8'), /Pending/)
  }

  console.log(JSON.stringify({ phase: 'paused', elapsedMs: performance.now() - started }))
  await session.waitForIdle()
  await session.prompt(
    `Reassign task ${ids[0]} exclusively to b.md and task ${ids[1]} ` +
      'exclusively to a.md. The complete revised assignment for each is to preserve its retained ' +
      'draft and original title, change Draft. to Final., and run document_check. The slow check ' +
      'is no longer required. No reviewer. Revise both together, keep them paused, and describe ' +
      'the new ownership in one sentence. Do not directly edit files or start new tasks.',
  )
  assert.ok(calls.includes('revise_tasks'))
  const revised = await Promise.all(ids.map((id) => jobs.get(id)))
  assert.deepEqual(
    revised.map((task) => task.request.writePaths),
    [['b.md'], ['a.md']],
  )

  for (const task of revised) {
    assert.equal(task.state.status, 'paused')
    const control = await readJson<TaskControls>(
      join(delegationDirectory(jobs.store, task.request.id), 'controls.json'),
    )
    assert.equal(control?.revision, 2)
    assert.equal(control?.baseRevision, 1)
  }

  await session.prompt(
    'Resume both revised tasks now. Continue our discussion with a concise ' +
      'explanation of scope ownership while they work. Leave the document edits to the workers.',
  )
  assert.equal(calls.filter((name) => name === 'resume_task').length, 2)
  const completed = await waitFor(ids, async (current) =>
    current.every((task) => task.state.status === 'complete'),
  )

  for (const name of ['a', 'b']) {
    assert.equal(
      await readFile(join(root, `${name}.md`), 'utf8'),
      `# ${name.toUpperCase()}\n\nFinal.\n`,
    )
  }

  assert.equal(
    calls.some((name) => ['write', 'edit'].includes(name)),
    false,
  )
  await session.waitForIdle()
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    calls,
    tasks: completed,
    elapsedMs: performance.now() - started,
  })
  console.log(JSON.stringify({ status: 'passed', reports }))
} finally {
  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  session.dispose()
  await runtime.settleCredentialWrites()
}
