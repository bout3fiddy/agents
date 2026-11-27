import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dispatcher } from '../src/dispatch.ts'
import { runJob } from '../src/job-runner.ts'
import { JobStore, type JobSpec } from '../src/job-store.ts'
import { evidence } from './support.ts'

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

/** A project with one required test check that passes unless src/value.js says "broken". */
async function project(t: TestContext, options: { git?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pi-job-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project')
  await mkdir(join(root, '.pi'), { recursive: true })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/value.js'), 'export const value = 0\n')
  const check =
    "const s=require('fs').readFileSync('src/value.js','utf8');" +
    "if(s.includes('broken')){console.error('src/value.js:1:1 broken');process.exit(1)}"
  const checks = [
    { id: 'contract', argv: ['node', '-e', check], required: true, kind: 'test', timeoutMs: 10000 },
  ]
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ checks }, null, 2) + '\n')

  if (options.git !== false) {
    execFileSync('git', ['init', '-q', '--template=', '-b', 'main', root])
    git(root, 'config', 'user.email', 'test@example.org')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'initial')
  }

  const store = new JobStore(root, join(base, 'state'))
  t.after(() => store.close())
  return { base, root, store }
}

const spec = (change: Partial<JobSpec> = {}): JobSpec => ({
  title: 'Set the value',
  task: 'Make value 1.',
  mode: 'implement',
  deliver: 'apply',
  writePaths: ['src/**'],
  model: 'fixture/model',
  ...change,
})

/** A worker that writes files into its copy and reports a passing result. */
const writes =
  (files: Record<string, string>, seen?: string[]): Dispatcher =>
  async (request) => {
    seen?.push(request.task)

    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(request.workspace, name, '..'), { recursive: true })
      await writeFile(join(request.workspace, name), text)
    }

    return evidence(request)
  }

test('a verified result is applied to the working tree without touching Git state', async (t) => {
  const { root, store } = await project(t)
  await writeFile(join(root, 'notes.txt'), 'untracked and unrelated\n')
  await writeFile(join(root, 'src/dirty.js'), 'export const dirty = true\n')
  const head = git(root, 'rev-parse', 'HEAD')
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request) => {
    assert.equal(
      await readFile(join(request.workspace, 'src/dirty.js'), 'utf8'),
      'export const dirty = true\n',
      'the copy starts from the working tree, uncommitted files included',
    )
    return writes({ 'src/value.js': 'export const value = 1\n' })(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.deepEqual(done?.result.changed, ['src/value.js'])
  assert.deepEqual(done?.result.checks?.map(({ check, status }) => `${check} ${status}`).sort(), [
    'contract passed',
    'harness-lint passed',
  ])
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(git(root, 'status', '--porcelain'), 'M src/value.js\n?? notes.txt\n?? src/dirty.js')
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'nothing is staged')
  assert.equal(git(root, 'stash', 'list'), '')
  assert.deepEqual(
    store.pendingEvents('s1').map((event) => event.job),
    [job.id],
  )
})

test('a directory without Git is isolated and applied through a shadow store', async (t) => {
  const { root, store } = await project(t, { git: false })
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, writes({ 'src/value.js': 'export const value = 1\n' }))
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
  await assert.rejects(readFile(join(root, '.git/HEAD')), { code: 'ENOENT' })
})

test('a concurrent edit to a changed path blocks delivery and keeps the result', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request) => {
    await writeFile(join(root, 'src/value.js'), 'export const value = 7 // user\n')
    return writes({ 'src/value.js': 'export const value = 1\n', 'src/new.js': '// new\n' })(request)
  })
  assert.equal(done?.status, 'needs_attention')
  assert.deepEqual(done?.result.conflicts, ['src/value.js'])
  assert.equal(
    await readFile(join(root, 'src/value.js'), 'utf8'),
    'export const value = 7 // user\n',
  )
  await assert.rejects(readFile(join(root, 'src/new.js')), { code: 'ENOENT' })
  assert.equal(git(root, 'show', `${done!.head}:src/value.js`), 'export const value = 1')
})

test('a retry after a delivery conflict rebuilds on the current files', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const stopped = await runJob(store, job.id, async (request) => {
    await writeFile(join(root, 'src/value.js'), 'export const value = 7 // user\n')
    return writes({ 'src/value.js': 'export const value = 1\n', 'src/new.js': '// new\n' })(request)
  })
  assert.deepEqual(stopped?.result.conflicts, ['src/value.js'])
  store.requeue(job.id)
  const tasks: string[] = []
  const done = await runJob(store, job.id, async (request) => {
    const current = await readFile(join(request.workspace, 'src/value.js'), 'utf8')
    assert.equal(current, 'export const value = 7 // user\n', 'the worker sees the current file')
    return writes({ 'src/value.js': 'export const value = 1 // user\n' }, tasks)(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.match(tasks[0]!, /src\/value\.js changed in the checkout meanwhile/)
  assert.equal(
    await readFile(join(root, 'src/value.js'), 'utf8'),
    'export const value = 1 // user\n',
  )
})

test('a retry after a conflict keeps earlier work that does not overlap', async (t) => {
  const { root, store } = await project(t)
  const lines = (first: string, last: string) => `${first}\n\n// middle\n\n${last}\n`
  await writeFile(join(root, 'src/long.js'), lines('// top', '// end'))
  const job = store.create({ root, session: 's1', spec: spec() })
  const stopped = await runJob(store, job.id, async (request) => {
    await writeFile(join(root, 'src/long.js'), lines('// top by user', '// end'))
    return writes({
      'src/value.js': 'export const value = 1\n',
      'src/long.js': lines('// top', '// end by job'),
    })(request)
  })
  assert.deepEqual(stopped?.result.conflicts, ['src/long.js'])
  store.requeue(job.id)
  const done = await runJob(store, job.id, async (request) => {
    const merged = await readFile(join(request.workspace, 'src/long.js'), 'utf8')
    assert.equal(merged, lines('// top by user', '// end by job'))
    return evidence(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(
    await readFile(join(root, 'src/long.js'), 'utf8'),
    lines('// top by user', '// end by job'),
  )
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
})

test('an unrelated concurrent edit does not block delivery', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request) => {
    await writeFile(join(root, 'README.md'), '# Written meanwhile\n')
    return writes({ 'src/value.js': 'export const value = 1\n' })(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Written meanwhile\n')
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
})

test('failed checks return to the worker, and only host receipts pass the job', async (t) => {
  const { root, store } = await project(t)
  const tasks: string[] = []
  let round = 0
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request) => {
    round++
    return writes(
      { 'src/value.js': round === 1 ? '// broken\n' : 'export const value = 1\n' },
      tasks,
    )(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(done?.round, 2)
  assert.match(tasks[1]!, /requiredChecksFailed/)
  assert.match(tasks[1]!, /src\/value\.js:1:1 broken/)
})

test('a repair that leaves the same failure stops with the work retained', async (t) => {
  const { root, store } = await project(t)
  let round = 0
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request) =>
    writes({ 'src/value.js': `// broken ${++round}\n` })(request),
  )
  assert.equal(done?.status, 'needs_attention')
  assert.match(done!.error!, /made no progress; the same failure repeated after edits/)
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 0\n')
  assert.match(git(root, 'show', `${done!.wip}:src/value.js`), /broken 2/)
})

test('an edit outside the write scope fails the job whatever the worker reports', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, writes({ 'package.json': '{}\n' }))
  assert.equal(done?.status, 'needs_attention')
  assert.match(done!.error!, /outside the assigned write scope: package\.json/)
  await assert.rejects(readFile(join(root, 'package.json')), { code: 'ENOENT' })
})

test('research is read-only and delivers its report', async (t) => {
  const { root, store } = await project(t)
  const research = spec({ mode: 'research', deliver: 'none', writePaths: [] })
  const report = store.create({ root, session: 's1', spec: research })
  const done = await runJob(store, report.id, async (request) => {
    assert.equal(request.role, 'task-worker')
    return evidence(request, { summary: 'The value is 0.' })
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(done?.summary, 'The value is 0.')
  const edit = store.create({ root, session: 's1', spec: research })
  const refused = await runJob(store, edit.id, writes({ 'src/value.js': 'changed\n' }))
  assert.match(refused!.error!, /read-only job changed a file/)
})

test('documents are checked for formatting before they are applied', async (t) => {
  const { root, store } = await project(t)
  const documents = spec({ mode: 'documents', writePaths: ['docs/**'] })
  const job = store.create({ root, session: 's1', spec: documents })
  const tasks: string[] = []
  let round = 0
  const done = await runJob(store, job.id, async (request) => {
    round++
    return writes(
      { 'docs/guide.md': round === 1 ? '#  Guide\n\n\n\ntext\n' : '# Guide\n\ntext\n' },
      tasks,
    )(request)
  })
  assert.equal(done?.status, 'done', done?.error)
  assert.match(tasks[1]!, /documentChecksFailed/)
  assert.equal(await readFile(join(root, 'docs/guide.md'), 'utf8'), '# Guide\n\ntext\n')
  const code = store.create({
    root,
    session: 's1',
    spec: spec({ ...documents, writePaths: ['**'] }),
  })
  const refused = await runJob(store, code.id, writes({ 'docs/tool.js': '// code\n' }))
  assert.match(refused!.error!, /outside the assigned write scope/)
})

test('branch delivery commits on a local branch and leaves the checkout alone', async (t) => {
  const { root, store } = await project(t)
  const base = git(root, 'rev-parse', 'HEAD')
  const branch = spec({ deliver: 'branch', branch: 'feat/value' })
  const job = store.create({ root, session: 's1', spec: branch })
  const done = await runJob(store, job.id, writes({ 'src/value.js': 'export const value = 1\n' }))
  assert.equal(done?.status, 'done', done?.error)
  assert.equal(git(root, 'rev-parse', 'feat/value'), done!.head)
  assert.equal(git(root, 'rev-parse', 'feat/value^'), base)
  assert.equal(git(root, 'log', '-1', '--format=%an %s', 'feat/value'), 'Test Set the value')
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 0\n')
  assert.equal(git(root, 'status', '--porcelain'), '')

  // A second job continues the branch from its tip.
  const next = store.create({ root, session: 's1', spec: branch })
  const again = await runJob(store, next.id, writes({ 'src/more.js': 'export const more = 2\n' }))
  assert.equal(again?.status, 'done', again?.error)
  assert.equal(git(root, 'rev-parse', 'feat/value^'), done!.head)
  assert.equal(git(root, 'show', 'feat/value:src/value.js'), 'export const value = 1')
})

test('a blocked worker hands its host actions back', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const hostActions = [{ capability: 'network' as const, reason: 'Needs the registry' }]
  const done = await runJob(store, job.id, (request) =>
    evidence(request, { verdict: 'blocked', summary: 'Install first', hostActions }),
  )
  assert.equal(done?.status, 'needs_attention')
  assert.deepEqual(done?.result.hostActions, hostActions)
})

test('a retry continues from the retained work with the host guidance', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  let round = 0
  const first = await runJob(store, job.id, async (request) =>
    writes({ 'src/value.js': `// broken ${++round}\n`, 'src/kept.js': '// kept\n' })(request),
  )
  assert.equal(first?.status, 'needs_attention')
  store.acknowledge(store.pendingEvents('s1').map((event) => event.id))
  store.addMessage(job.id, 'Remove the word broken.')
  store.requeue(job.id)
  const tasks: string[] = []
  const second = await runJob(store, job.id, async (request) => {
    assert.equal(await readFile(join(request.workspace, 'src/kept.js'), 'utf8'), '// kept\n')
    return writes({ 'src/value.js': 'export const value = 1\n' }, tasks)(request)
  })
  assert.equal(second?.status, 'done', second?.error)
  assert.match(tasks[0]!, /Remove the word broken/)
  assert.match(tasks[0]!, /earlier run of this job stopped/)
  assert.equal(await readFile(join(root, 'src/kept.js'), 'utf8'), '// kept\n')
  assert.equal(store.pendingEvents('s1').length, 1)
})

test('a user cancellation stops the worker and keeps the job cancelled', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({ root, session: 's1', spec: spec() })
  const done = await runJob(store, job.id, async (request, signal) => {
    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 1\n')
    store.requestCancel(job.id)
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve()))
    throw new Error('Worker cancelled')
  })
  assert.equal(done?.status, 'cancelled')
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 0\n')
  assert.equal(await runJob(store, job.id), undefined, 'a cancelled job is not claimed again')
})

test('a stop retains the checkpoint; retry reads execution policy anew', async (t) => {
  const { root, store } = await project(t)
  const job = store.create({
    root,
    session: 's1',
    spec: spec({
      mode: 'documents',
      writePaths: ['notes.txt'],
      isolation: 'required',
    }),
  })
  const first = await runJob(store, job.id, async (request) => {
    assert.equal(request.project.execution?.reason, 'task-policy')
    store.requestCancel(job.id, 'Correct the notes before delivery.')
    return writes({ 'notes.txt': 'First draft.\n' })(request)
  })
  assert.equal(first?.status, 'cancelled', first?.error)
  assert.equal(first.summary, 'Correct the notes before delivery.')
  assert.ok(first.wip)
  await assert.rejects(readFile(join(root, 'notes.txt')), { code: 'ENOENT' })
  store.requeue(job.id, 'Revise the draft.')
  const saved = process.env.PI_HARNESS_ISOLATION
  process.env.PI_HARNESS_ISOLATION = 'required'

  try {
    const done = await runJob(store, job.id, async (request) => {
      assert.equal(request.project.execution?.reason, 'host-policy')
      assert.equal(request.model, job.spec.model)
      assert.equal(request.checkpoint?.acceptedAt, job.createdAt)
      assert.deepEqual(request.checkpoint?.writePaths, job.spec.writePaths)
      assert.equal(await readFile(join(request.workspace, 'notes.txt'), 'utf8'), 'First draft.\n')
      assert.match(request.task, /Revise the draft/)
      return writes({ 'notes.txt': 'Corrected draft.\n' })(request)
    })
    assert.equal(done?.status, 'done', done?.error)
    assert.deepEqual(done.spec, job.spec)
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'Corrected draft.\n')
  } finally {
    if (saved === undefined) {
      delete process.env.PI_HARNESS_ISOLATION
    } else {
      process.env.PI_HARNESS_ISOLATION = saved
    }
  }
})

test('required isolation reaches the worker whatever the project trusts', async (t) => {
  const { root, store } = await project(t)
  const modes: (string | undefined)[] = []
  const observe =
    (files: Record<string, string>): Dispatcher =>
    async (request) => {
      modes.push(request.project.execution?.mode)
      return writes(files)(request)
    }
  const isolated = store.create({ root, session: 's1', spec: spec({ isolation: 'required' }) })
  const done = await runJob(
    store,
    isolated.id,
    observe({ 'src/value.js': 'export const value = 1\n' }),
  )
  assert.equal(done?.status, 'done', done?.error)
  const ordinary = store.create({ root, session: 's1', spec: spec() })
  await runJob(store, ordinary.id, observe({ 'src/value.js': 'export const value = 2\n' }))
  assert.deepEqual(modes, ['required-isolation', 'isolated'])
})

test('a session in a subdirectory changes only its own part of the repository', async (t) => {
  const { base, root, store } = await project(t)
  const outer = join(base, 'monorepo')
  await mkdir(join(outer, 'packages'), { recursive: true })
  await writeFile(join(outer, 'root.txt'), 'top level\n')
  execFileSync('git', ['init', '-q', '--template=', '-b', 'main', outer])
  git(outer, 'config', 'user.email', 'test@example.org')
  git(outer, 'config', 'user.name', 'Test')
  await rm(join(root, '.git'), { recursive: true })
  execFileSync('mv', [root, join(outer, 'packages/app')])
  const app = await realpath(join(outer, 'packages/app'))
  git(outer, 'add', '-A')
  git(outer, 'commit', '-q', '-m', 'initial')
  await writeFile(join(app, 'src/dirty.js'), '// uncommitted\n')
  const seen: string[] = []
  const worker: Dispatcher = async (request) => {
    seen.push(...(await readdir(request.workspace)).sort())
    assert.equal(
      await readFile(join(request.workspace, 'src/dirty.js'), 'utf8'),
      '// uncommitted\n',
    )
    return writes({ 'src/value.js': 'export const value = 1\n' })(request)
  }
  const applied = store.create({ root: app, session: 's1', spec: spec() })
  const done = await runJob(store, applied.id, worker)
  assert.equal(done?.status, 'done', done?.error)
  assert.deepEqual(seen, ['.pi', 'src'], 'the worker sees its directory, not the whole repository')
  assert.deepEqual(done?.result.changed, ['src/value.js'])
  assert.equal(await readFile(join(app, 'src/value.js'), 'utf8'), 'export const value = 1\n')
  assert.equal(
    git(outer, 'status', '--porcelain'),
    'M packages/app/src/value.js\n?? packages/app/src/dirty.js',
  )
  git(outer, 'checkout', '-q', '--', '.')
  await rm(join(app, 'src/dirty.js'))
  const branch = spec({ deliver: 'branch', branch: 'feat/app' })
  const published = store.create({ root: app, session: 's1', spec: branch })
  const committed = await runJob(
    store,
    published.id,
    writes({ 'src/value.js': 'export const value = 2\n' }),
  )
  assert.equal(committed?.status, 'done', committed?.error)
  assert.equal(git(outer, 'show', 'feat/app:packages/app/src/value.js'), 'export const value = 2')
  assert.equal(git(outer, 'show', 'feat/app:root.txt'), 'top level', 'the rest of the tree is kept')
  assert.equal(git(outer, 'diff', '--name-only', 'main', 'feat/app'), 'packages/app/src/value.js')
})
