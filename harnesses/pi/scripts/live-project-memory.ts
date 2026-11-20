import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import harness from '../src/extension.ts'
import { briefName, readBrief, repositoryStore } from '../src/memory-files.ts'
import { memoryRepository } from '../src/memory-repository.ts'
import { StateStore, atomicJson, readJson } from '../src/state.ts'
import { loadRole } from '../src/roles.ts'

const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-live-')))
const root = join(base, 'original')
const other = join(base, 'customer')
const auth = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
process.env.PI_HARNESS_AGENT_DIR = join(base, 'agent')
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
await mkdir(root)
git('init', '-qb', 'main')
await mkdir(join(root, 'src'))
await mkdir(join(root, 'tests'))
await writeFile(
  join(root, 'README.md'),
  '# Relay Desk\n\nRelay Desk synchronizes customer orders.' +
    ' The integration supports production and sandbox endpoints.\n',
)
await writeFile(join(root, 'src', 'integration.ts'), 'export function syncOrders() { return [] }\n')
await writeFile(
  join(root, 'tests', 'integration.test.ts'),
  '// Integration coverage for syncOrders\n',
)
git('add', '.')
git('-c', 'user.name=Pi', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'fixture')
git('worktree', 'add', '-qb', 'demo', other)
const runtime = await ModelRuntime.create({
  authPath: join(auth, 'auth.json'),
  modelsPath: join(auth, 'models.json'),
  modelsStorePath: join(auth, 'models-store.json'),
})
const model = runtime.getModel('openai-codex', 'gpt-6.2-astra')
assert.ok(model)

async function chat(cwd: string) {
  const settingsManager = SettingsManager.inMemory()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(base, 'agent'),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [harness],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'medium',
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(base, 'sessions')),
    tools: (await loadRole('orchestrator')).tools,
  })
  await session.bindExtensions({ onError: (e) => console.error(e) })
  return session
}

type Chat = Awaited<ReturnType<typeof chat>>

async function ask(session: Chat, text: string) {
  await session.prompt(text)
  await session.waitForIdle()
  const entry = session.messages.findLast((m) => m.role === 'assistant')
  assert.ok(entry?.role === 'assistant' && entry.stopReason !== 'error', entry?.errorMessage)
  const answer = entry.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  console.log(JSON.stringify({ text, answer }))
  return answer
}

console.log('Live fixture ' + base)
const repo = await memoryRepository(root)
assert.ok(repo)
const a = await chat(root)
await ask(a, 'Planning only for now. What does this project do and where is its integration?')
const db = repositoryStore(repo)
assert.match(JSON.stringify(db.facts()), /Relay Desk/i)
assert.ok(db.facts().some((f) => f.paths.includes('src/integration.ts')))
await ask(
  a,
  'Our priority is the Friday customer demo. Success requires a live production integration.',
)
const conflict = await ask(a, 'The customer won’t issue production credentials until Monday.')
assert.match(conflict, /Friday/i)
assert.match(conflict, /block|cannot|can't|won’t|unavailable|at risk|can’t|cannot meet/i)
await ask(a, 'Maybe PDF export someday.')
assert.ok(db.facts().every((f) => !/PDF/i.test(f.text) || f.kind === 'tentative'))
await a.dispose()

// Real executable evidence on a distinct branch, delivered through a fixture coordinator record.
await writeFile(
  join(other, 'src/integration.ts'),
  'export function syncOrders(orders: string[]) { return [...new Set(orders)] }\n',
)
await writeFile(
  join(other, 'tests/orders.test.mjs'),
  "import assert from 'node:assert/strict'\nimport { syncOrders } from '../src/integration.ts'\n" +
    "assert.deepEqual(syncOrders(['order-1','order-1']),['order-1'])\n",
)
execFileSync('git', ['-C', other, 'add', 'src/integration.ts', 'tests/orders.test.mjs'])
execFileSync('git', [
  '-C',
  other,
  '-c',
  'user.name=Pi',
  '-c',
  'user.email=pi@example.invalid',
  'commit',
  '-qm',
  'Deduplicate orders',
])
const branchTip = git('rev-parse', 'demo')
assert.notEqual(branchTip, git('rev-parse', 'HEAD'))
const started = performance.now()
const argv = [process.execPath, '--test', 'tests/orders.test.mjs']
const output = execFileSync(process.execPath, argv.slice(1), { cwd: other, encoding: 'utf8' })
const durationMs = Math.round(performance.now() - started)
const snapshot = createHash('sha256')
  .update(execFileSync('git', ['-C', other, 'archive', 'HEAD']))
  .digest('hex')
const store = new StateStore(root)
const id = '351bdf0d-39bf-4145-9aa1-c50334457ad1'
const dir = join(store.directory, 'delegations', id)
const indexPath = join(store.directory, 'delegations', 'index.json')
const prior = (await readJson<string[]>(indexPath)) ?? []
await atomicJson(indexPath, [...prior, id])
await atomicJson(join(dir, 'request.json'), {
  root,
  id,
  session: 'previous-worker-session',
  kind: 'branch',
  task: 'Integration tests',
  createdAt: new Date().toISOString(),
  writePaths: ['tests/**'],
})
await atomicJson(join(dir, 'status.json'), {
  id,
  status: 'published',
  branch: 'demo',
  commit: branchTip,
  receipts: [
    {
      check: 'branch tests',
      status: 'passed',
      snapshot,
      result: { argv, exitCode: 0, durationMs, output },
    },
  ],
  updatedAt: new Date().toISOString(),
  summary: 'Branch tests passed.',
})
const b = await chat(other)
const next = await ask(b, 'What next?')
assert.match(next, /Monday/i)
assert.match(next, /Friday/i)
assert.match(next, /sandbox|customer/i)
const branch = await ask(b, 'What does the worker result establish? Is this shipped?')
assert.match(branch, /published|branch/i)
assert.match(branch, /not shipped|not.*released|no.*release|doesn.t.*ship|no.*ship/i)
await ask(b, 'The production credentials arrived early. The team has them now.')
await b.dispose()
const c = await chat(root)
const unblocked = await ask(c, 'What next?')
assert.match(unblocked, /production|live integration/i)
const credentialHistory = db.facts().flatMap((f) => db.history(f.key))
assert.ok(
  credentialHistory.some(
    (h) => Number(h.revision) > 1 && /arrived early|has them now/i.test(String(h.quote)),
  ),
)
assert.match(unblocked, /credential|access/i)
assert.ok(db.facts().some((f) => f.revision > 1 && /arrived early|has them now/i.test(f.quote)))
console.log(JSON.stringify({ facts: db.facts(), sources: db.sources() }))
await c.dispose()
db.close()

const brief = readBrief(root)
assert.match(brief, /Friday/i)
assert.doesNotMatch(brief, /session:|PDF export|\.pi\/traces/i)
git('add', '-f', '--', briefName)
git(
  '-c',
  'user.name=Pi',
  '-c',
  'user.email=pi@example.invalid',
  'commit',
  '--only',
  '-qm',
  'Checkpoint project state',
  '--',
  briefName,
)
const clone = join(base, 'fresh-clone')
git('clone', '-q', root, clone)
const fresh = await chat(clone)

try {
  const recalled = await ask(fresh, 'What is our priority, and are we still waiting for access?')
  assert.match(recalled, /Friday/i)
  assert.match(recalled, /production|live integration/i)
  assert.match(recalled, /receiv|arriv|have|available|obtained|no longer/i)
} finally {
  await fresh.dispose()
}
