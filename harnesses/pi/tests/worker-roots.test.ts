import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './support.ts'
import { Delegations, delegationDirectory } from '../src/delegation-state.ts'
import { safeTrace, WorkerRoots } from '../src/worker-roots.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { LiveWorker } from '../src/worker-live.ts'
import { WorkersCatalog } from '../src/workers-data.ts'

test('origin catalog routes an active child stored only in the target checkout', async (t) => {
  const host = await fixture()
  const target = await fixture()
  t.after(() => rm(host.base, { recursive: true, force: true }))
  t.after(() => rm(target.base, { recursive: true, force: true }))
  const agentDir = join(await realpath(host.base), 'agent')
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = agentDir
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_HARNESS_AGENT_DIR
    } else {
      process.env.PI_HARNESS_AGENT_DIR = previous
    }
  })
  const store = new StateStore(target.root)
  const origin = { originRoot: host.root, session: 'host-session', model: 'test/model' }
  const job = await new Delegations(store).start(
    { kind: 'research', context: '', task: 'Inspect the queue', writePaths: [], title: 'Queue' },
    origin,
    async () => {},
  )
  const worker = await LiveWorker.start(target.root, {
    role: 'implementer',
    model: origin.model,
    task: job.request.task,
    scope: [],
    output: join(delegationDirectory(store, job.request.id), 'leaf.json'),
    workspace: target.root,
    backend: 'pi',
  })
  const catalog = new WorkersCatalog(host.root)
  const row = (await catalog.list()).find((item) => item.info.id === worker.info.id)
  assert.ok(row?.active, 'origin must see the active foreign child')
  await worker.append('assistant', 'Owner transcript')
  assert.equal((await catalog.conversation(row)).entries.at(-1)?.text, 'Owner transcript')

  // Give the origin a different worker with the same UUID. A remote selection must stay remote.
  const local = join(new StateStore(host.root).directory, 'workers', worker.info.id)
  await mkdir(local, { recursive: true })
  await atomicJson(join(local, 'info.json'), {
    ...worker.info,
    projectRoot: await realpath(host.root),
    taskId: undefined,
    output: join(local, 'output'),
  })
  await atomicJson(join(local, 'state.json'), row.state)
  await atomicJson(join(local, 'mailbox.json'), { accepting: true, messages: [] })
  const forged = { ...row, transcript: join(local, 'conversation.jsonl'), directory: local }
  await writeFile(forged.transcript, '{"text":"Wrong worker"}\n')
  assert.equal((await catalog.conversation(forged)).entries.at(-1)?.text, 'Owner transcript')
  await catalog.send(row.id, 'Keep the existing scope.')
  assert.equal((await worker.mailbox.read()).messages.at(-1)?.text, 'Keep the existing scope.')
  const roots = new WorkerRoots(new StateStore(host.root), agentDir)
  const [entry] = await roots.entries()
  await roots.register(entry!)
  const unrelated = new WorkersCatalog(host.root, undefined, roots, 'another')
  assert.deepEqual(
    (await unrelated.list()).map((item) => item.info.taskId),
    [undefined],
  )
  assert.equal((await roots.entries()).length, 1)
  await assert.rejects(roots.register({ ...entry!, session: 'unrelated' }), /provenance mismatch/)
  await atomicJson(roots.path, [null, { ...entry, taskId: '../../private' }, entry])
  assert.ok((await catalog.list()).some((item) => item.id === row.id))
  assert.ok(catalog.warnings.length)
  const channel = join(worker.directory, 'mailbox.lock')
  await rm(channel, { force: true })
  await symlink(join(local, 'private'), channel)
  await assert.rejects(catalog.send(row.id, 'Late guidance'), /no longer available/)
  await rm(target.base, { recursive: true, force: true })
  assert.deepEqual(
    (await catalog.list()).map((item) => item.info.id),
    [worker.info.id],
  )
  assert.ok(catalog.warnings.length)
})

test('a trusted external state alias does not authorize a linked registry ancestor', async (t) => {
  const host = await fixture()
  t.after(() => rm(host.base, { recursive: true, force: true }))
  const base = await realpath(host.base)
  const alias = join(base, 'alias')
  await symlink(base, alias)
  const store = new StateStore(host.root, join(alias, 'state'))
  const receipt = await safeTrace(store, join(store.directory, 'accepted.json'))
  assert.equal(await realpath(receipt), await realpath(join(host.store.directory, 'accepted.json')))

  const registry = new WorkerRoots(store, join(alias, 'agent'))
  await assert.rejects(registry.entries(), /Linked worker traces/)
})

test('host CLI backfills legacy provenance without changing task data', async (t) => {
  const origin = await fixture()
  const target = await fixture()
  t.after(() => rm(origin.base, { recursive: true, force: true }))
  t.after(() => rm(target.base, { recursive: true, force: true }))
  const jobs = new Delegations(new StateStore(target.root))
  const job = await jobs.start(
    { kind: 'research', context: '', task: 'Old job', writePaths: [] },
    { session: 'legacy', model: 'test/model' },
    async () => {},
  )
  const directory = delegationDirectory(jobs.store, job.request.id)
  const requestPath = join(directory, 'request.json')
  await atomicJson(requestPath, { ...job.request, originRoot: undefined, originSession: undefined })
  const snapshot = () =>
    Promise.all(
      ['request.json', 'status.json', 'controls.json'].map((name) =>
        readFile(join(directory, name), 'utf8'),
      ),
    )
  const before = await snapshot()
  const agentDir = join(await realpath(origin.base), 'private')
  const roots = new WorkerRoots(new StateStore(origin.root), agentDir)
  const catalog = new WorkersCatalog(origin.root, undefined, roots, 'legacy')
  const entry = { root: jobs.store.projectRoot, taskId: job.request.id, session: 'legacy' }
  await atomicJson(roots.path, [entry])
  assert.equal((await catalog.list()).length, 0, 'forged index alone cannot bind an older job')
  execFileSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'register-worker-origin',
      target.root,
      job.request.id,
      'legacy',
    ],
    { cwd: origin.root, env: { ...process.env, PI_HARNESS_AGENT_DIR: agentDir } },
  )
  assert.equal((await catalog.list())[0]?.info.taskId, job.request.id)
  assert.deepEqual(await snapshot(), before)
})
