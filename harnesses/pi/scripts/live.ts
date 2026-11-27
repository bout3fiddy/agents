import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { JobStore, jobView } from '../src/job-store.ts'
import { harnessRoot } from '../src/project.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'
import { WorkersCatalog } from '../src/workers-data.ts'
import { basicFixture } from './live-basic-fixture.ts'

// One real journey: the orchestrator model starts a job, a real implementer works in an isolated
// copy, the host runs the project's check and the verified result lands in the checkout.
const implementer = process.argv.includes('--opus')
  ? 'opus'
  : process.argv.includes('--fable')
    ? 'fable'
    : undefined
const { root, design } = await basicFixture()
execFileSync('git', ['init', '-q', '-b', 'main', root])
const model = process.env.PI_HARNESS_LIVE_MODEL ?? 'openai-codex/gpt-6.2-astra'
const reports = join(harnessRoot, 'reports', new Date().toISOString().replaceAll(':', '-'))
await mkdir(reports, { recursive: true })
console.log(JSON.stringify({ root, reports, model }))
const cli = join(harnessRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
const timer = setTimeout(() => controller.abort(), 60 * 60 * 1000)
let output = ''
let errorOutput = ''
const child = spawn(
  process.execPath,
  [
    cli,
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
    '--model',
    model,
    '--thinking',
    'medium',
    '--mode',
    'json',
    '-p',
    (implementer ? `Use ${implementer} to implement this design. ` : '') +
      'Implement this settled design now as one job and tell me its ID. Return while it runs ' +
      'in the background; do not wait or poll.\n' +
      JSON.stringify(design),
  ],
  {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_AGENT_DIR: agentDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: controller.signal,
  },
)
child.stdout.on('data', (chunk: Buffer) => {
  output = (output + chunk.toString()).slice(-8_000_000)
})
child.stderr.on('data', (chunk: Buffer) => {
  errorOutput = (errorOutput + chunk.toString()).slice(-16000)
})
const code = await new Promise<number | null>((resolve) => {
  child.once('error', () => resolve(null))
  child.once('close', resolve)
})
await writeFile(join(reports, 'orchestrator.jsonl'), output)
await writeFile(join(reports, 'stderr.txt'), errorOutput)
assert.equal(code, 0, errorOutput)
const store = JobStore.open(root)
let [job] = store.list()
assert.ok(job, 'The orchestrator must start a job')

while ((job.status === 'queued' || job.status === 'running') && !controller.signal.aborted) {
  await delay(1000)
  store.reconcile()
  job = store.get(job.id)
}

clearTimeout(timer)

if (job.status === 'running') {
  store.requestCancel(job.id)
}

const workers = await new WorkersCatalog(root).list()
await atomicJson(join(reports, 'result.json'), { root, job, workers: workers.map((w) => w.info) })
console.log(JSON.stringify({ ...jobView(job), reports }, null, 2))
assert.equal(job.status, 'done', job.error ?? output.slice(-4000))
assert.equal(job.spec.mode, 'implement')
assert.deepEqual(job.result.changed, ['src/count.mjs'])
assert.ok(job.result.checks?.length && job.result.checks.every((c) => c.status === 'passed'))
assert.match(await readFile(join(root, 'src/count.mjs'), 'utf8'), /parseCount/)
execFileSync('node', ['--test', 'tests/count.mjs'], { cwd: root, stdio: 'inherit' })
assert.ok(
  workers.some((row) => row.info.taskId === job.id && row.info.role === 'implementer'),
  'The implementer must be recorded against its job',
)
assert.equal(store.pendingEvents(job.session).length, 1, 'The outcome awaits its session')
store.close()
