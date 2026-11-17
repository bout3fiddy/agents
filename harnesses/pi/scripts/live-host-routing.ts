import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
import { loadRole } from '../src/roles.ts'
import { harnessRoot } from '../src/project.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { Delegations, activeTask } from '../src/delegation-state.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-host-'))
const reports = join(harnessRoot, 'reports', `host-routing-${Date.now()}`)
await mkdir(reports, { recursive: true })
const agentDir = join(homedir(), '.pi/agent')
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
const calls: { name: string; args: unknown }[] = []
session.subscribe((event) => {
  if (event.type === 'tool_execution_start') {
    calls.push({ name: event.toolName, args: event.args })
  }
})
const jobs = new Delegations(new StateStore(root))
console.log(JSON.stringify({ root, reports }))

try {
  const start = performance.now()
  await session.prompt(
    'Set up this fresh directory as a small local Git repository on main. Add a concise README, ' +
      'sensible .gitignore excluding .pi and dependencies, package.json and an executable ' +
      'npm check command for authored-file formatting. Install and exactly pin prettier ' +
      '3.10.1, generate the ' +
      'real lockfile and run the check. Keep it minimal: no application code, deployment, remote ' +
      'publication or Git commit. This is routine repository setup.',
  )
  const setupMs = performance.now() - start
  assert.equal((await jobs.list()).length, 0, 'Fresh routine setup must remain on the host')
  assert.equal(
    calls.some((call) => ['consult_design', 'workflow'].includes(call.name)),
    false,
  )
  const run = promisify(execFile)
  const branch = await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root })
  assert.equal(branch.stdout.trim(), 'main')
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.packages['node_modules/prettier'].version, '3.10.1')
  await run('npm', ['run', 'check'], { cwd: root, timeout: 120000 })
  console.log(JSON.stringify({ phase: 'host-setup-passed', setupMs, calls: calls.length }))

  const original =
    '# Design\n\n' +
    'Unchanged context is retained.\n\n'.repeat(1300) +
    'Selected retry policy: exponential backoff.\n'
  await writeFile(join(root, 'design.md'), original)
  const before = calls.length
  const dispatched = performance.now()
  await session.prompt(
    'Use a separate background agent to change the selected retry policy in design.md from ' +
      'exponential backoff to bounded jitter, preserving the rest of the document exactly. ' +
      'We are now discussing retry behavior; ask me one conceptual question while it works.',
  )
  const dispatchMs = performance.now() - dispatched
  assert.equal((await jobs.list()).length, 1)
  assert.ok(calls.slice(before).some((call) => call.name === 'delegate_task'))
  assert.equal(
    calls.slice(before).some((call) => ['write', 'edit'].includes(call.name)),
    false,
  )
  await session.prompt('Explain the retry tradeoff in two sentences while the agent works.')
  const deadline = Date.now() + 300000
  let job = (await jobs.list())[0]!

  while (activeTask(job.state) && Date.now() < deadline) {
    await delay(1000)
    job = await jobs.get(job.request.id)
  }

  assert.equal(job.state.status, 'complete', job.state.error)
  assert.equal(
    await readFile(join(root, 'design.md'), 'utf8'),
    original.replace('exponential backoff', 'bounded jitter'),
  )
  const directory = join(root, '.pi/traces/harness/delegations', job.request.id)
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith('.jsonl'),
  )
  let edits = 0
  let fullWrites = 0

  for (const file of files) {
    for (const line of (await readFile(join(directory, file), 'utf8')).trim().split('\n')) {
      if (!line) {
        continue
      }

      const entry = JSON.parse(line)

      if (entry.message?.role !== 'assistant') {
        continue
      }

      for (const part of entry.message.content ?? []) {
        if (part.type !== 'toolCall') {
          continue
        }

        if (part.name === 'project_edit') {
          edits++
        }

        if (part.name === 'project_write') {
          fullWrites++
        }
      }
    }
  }

  assert.ok(edits > 0, 'Focused existing-document changes must use project_edit')
  assert.equal(fullWrites, 0)
  assert.equal(
    job.state.children?.some((child) => child.role === 'reviewer'),
    false,
  )
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    setupMs,
    dispatchMs,
    edits,
    fullWrites,
    task: job.state,
  })
  console.log(JSON.stringify({ status: 'passed', reports, setupMs, dispatchMs, edits }))
} catch (error) {
  await atomicJson(join(reports, 'result.json'), { status: 'failed', root, error: String(error) })
  throw error
} finally {
  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  await session.abort()
  session.dispose()
  await runtime.settleCredentialWrites()
}
