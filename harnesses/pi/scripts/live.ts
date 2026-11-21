import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { harnessRoot } from '../src/project.ts'
import { WorkersCatalog } from '../src/workers-data.ts'
import { atomicJson } from '../src/state.ts'
import { liveFixture } from './live-fixture.ts'
import { basicFixture } from './live-basic-fixture.ts'
import { loadRole } from '../src/roles.ts'
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { setTimeout as delay } from 'node:timers/promises'

const implementer = process.argv.includes('--opus')
  ? 'opus'
  : process.argv.includes('--fable')
    ? 'fable'
    : undefined
const basic = process.argv.includes('--basic')
const { root, store, design } = await (basic ? basicFixture() : liveFixture())
const model = process.env.PI_HARNESS_LIVE_MODEL ?? 'openai-codex/gpt-6.1-sol'
const reports = join(harnessRoot, 'reports', new Date().toISOString().replaceAll(':', '-'))
await mkdir(reports, { recursive: true })
console.log(JSON.stringify({ root, state: store.directory, reports, model }))
const cli = join(harnessRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
const flags = [
  '--no-extensions',
  '-e',
  join(harnessRoot, 'src/extension.ts'),
  '--no-skills',
  '--no-context-files',
  '--no-prompt-templates',
  '--no-mcp',
  '--no-approve',
  '--tools',
  (await loadRole('orchestrator')).tools.join(','),
]
const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
const environment = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_HARNESS_AGENT_DIR: agentDir,
}
assert.equal(await store.checkpoint(), undefined)
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
const timer = setTimeout(() => controller.abort(), 90 * 60 * 1000)
let output = ''
let errorOutput = ''
const child = spawn(
  process.execPath,
  [
    cli,
    ...flags,
    '--model',
    model,
    '--thinking',
    'medium',
    '--mode',
    'json',
    '-p',
    (implementer ? `Use ${implementer} to implement this design. ` : '') +
      'Implement this settled design now. Pass this exact design object to workflow and ' +
      'tell me the task ID. Return while it runs in the background; do not wait or poll.\n' +
      JSON.stringify(design),
  ],
  { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal },
)
child.stdout.on('data', (chunk: Buffer) => {
  output = (output + chunk.toString()).slice(-8_000_000)
})
child.stderr.on('data', (chunk: Buffer) => {
  errorOutput = (errorOutput + chunk.toString()).slice(-16000)
})
let processError: string | undefined
const code = await new Promise<number | null>((resolve) => {
  child.once('error', (error) => {
    processError = error.message
  })
  child.once('close', resolve)
}).finally(() => clearTimeout(timer))
await writeFile(join(reports, 'orchestrator.jsonl'), output)
await writeFile(join(reports, 'stderr.txt'), errorOutput)
const jobs = new Delegations(store)
const deadline = Date.now() + 90 * 60_000
let job = (await jobs.list()).at(-1)
assert.ok(job, 'The orchestrator must start a background workflow')

while (activeTask(job.state) && Date.now() < deadline && !controller.signal.aborted) {
  await delay(1000)
  job = await jobs.get(job.request.id)
}

if (activeTask(job.state)) {
  await jobs.control(job.request.id, 'cancel')
}

assert.equal(job.state.status, 'complete', job.state.error)
const checkpoint = await store.checkpoint()
assert.ok(checkpoint, 'Workflow must record its scope without a separate acceptance step')
const { hash: _hash, version: _version, acceptedAt: _acceptedAt, ...recorded } = checkpoint
assert.deepEqual(recorded, design)
const task = await store.task()
await atomicJson(join(reports, 'result.json'), {
  code,
  processError,
  root,
  state: store.directory,
  task,
})
console.log(
  JSON.stringify(
    {
      code,
      status: task?.status,
      rounds: task?.round,
      roles: task?.evidence.map((item) => item.role),
      error: task?.error,
      reports,
    },
    null,
    2,
  ),
)
assert.equal(code, 0, errorOutput)
assert.equal(task?.status, 'complete', task?.error ?? output.slice(-4000))
assert.deepEqual(
  new Set(task.evidence.map((item) => item.role)),
  new Set(
    basic
      ? ['implementer', 'reviewer']
      : ['implementer', 'performance', 'reviewer', 'database-reviewer'],
  ),
)
assert.ok(task.receipts.every((item) => item.status === 'passed'))

if (basic) {
  const writer = task.evidence.findLast((item) => item.role === 'implementer')
  const verdict = task.evidence.findLast((item) => item.role === 'reviewer' && !item.closedReview)
  assert.equal(writer?.result.verdict, 'pass')
  assert.ok(verdict?.liveWorkerId && writer?.liveWorkerId)
  assert.notEqual(verdict.liveWorkerId, writer.liveWorkerId)
  assert.equal(verdict.snapshot, writer.snapshot)
  assert.equal(verdict.snapshot, task.snapshot)
}

const workers = await new WorkersCatalog(root).list()

for (const item of task.evidence) {
  if (!item.closedReview) {
    const worker = workers.find((row) => row.id === item.liveWorkerId)
    assert.equal(worker?.info.taskId, job.request.id, 'Worker must belong to the delegated task')
  }

  if (item.closedReview) {
    assert.equal(item.model, 'harness/formatter')
    assert.equal(item.turns, 0)
    assert.ok(
      task.evidence.some(
        (original) =>
          original.role === item.role &&
          original.snapshot === item.closedReview!.snapshot &&
          original.model === item.closedReview!.model &&
          /^claude-cli\/(?:claude-fable-5-2|(?:claude-)?opus)(?:-|$)/.test(original.model),
      ),
    )
  } else if (item.role === 'implementer' && item.quotaFallbackFrom) {
    assert.equal(implementer, 'fable')
    assert.equal(item.quotaFallbackFrom, 'claude-fable-5-2')
    assert.match(item.model, /^claude-cli\/claude-opus-/)
    assert.equal(item.thinking, job.request.thinking ?? 'medium')
  } else if (item.role === 'implementer') {
    assert.equal(
      item.model,
      (await loadRole('implementer', undefined, implementer)).model.replace(
        /^claude-/,
        'claude-cli/claude-',
      ),
    )
  } else {
    assert.ok(/^claude-cli\/(?:claude-fable-5-2|(?:claude-)?opus)(?:-|$)/.test(item.model))
  }
}
