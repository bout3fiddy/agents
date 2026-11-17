import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { harnessRoot } from '../src/project.ts'
import { atomicJson } from '../src/state.ts'
import { liveFixture } from './live-fixture.ts'
import { basicFixture } from './live-basic-fixture.ts'
import { loadRole } from '../src/roles.ts'
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { setTimeout as delay } from 'node:timers/promises'

const basic = process.argv.includes('--basic')
const { root, store, hash } = await (basic ? basicFixture() : liveFixture())
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
const acceptance = promisify(execFile)(
  process.execPath,
  [cli, ...flags, '-p', `/accept-design ${hash}`],
  { cwd: root, env: environment, timeout: 120000 },
)
acceptance.child.stdin?.end()
const accepted = await acceptance
await writeFile(join(reports, 'acceptance.txt'), accepted.stdout + accepted.stderr)
assert.doesNotMatch(accepted.stderr, /Extension error/)
assert.equal((await store.checkpoint())?.hash, hash)
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
    'The accepted design is ready. Start workflow now and tell me the task ID. ' +
      'Return while it runs in the background; do not wait or poll.',
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
assert.ok(
  task.evidence.every((item) =>
    item.model.startsWith(
      item.role === 'implementer' ? 'openai-codex/' : 'claude-cli/claude-fable-5-2',
    ),
  ),
)
