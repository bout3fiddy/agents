import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

// Every temporary path in this file lives below a private TMPDIR.
const privateTemporary = await mkdtemp(join(tmpdir(), 'pi-cleanup-test-'))
process.env.TMPDIR = privateTemporary

const { cleanup, pruneProject } = await import('../src/cleanup.ts')
const { runDelegation } = await import('../src/delegation-runner.ts')
const { gitCommand } = await import('../src/git-branches.ts')
const { atomicJson, StateStore } = await import('../src/state.ts')
const { sweepTemporary, taskDirectory, temporaryDirectory, temporaryRoot } =
  await import('../src/temp.ts')

const hour = 60 * 60_000
const retentionMs = 48 * hour

test.after(() => rm(privateTemporary, { recursive: true, force: true }))

async function missing(path: string) {
  await assert.rejects(access(path), { code: 'ENOENT' })
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

async function repository(t: TestContext) {
  const root = await realpath(await mkdtemp(join(privateTemporary, 'project-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (args: string[]) => gitCommand(root, args)
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['config', 'user.email', 'pi@example.invalid'])
  await git(['config', 'user.name', 'Pi'])
  await writeFile(join(root, '.gitignore'), '.pi/\n')
  await writeFile(join(root, 'value.txt'), 'one\n')
  await git(['add', '.'])
  await git(['commit', '--quiet', '-m', 'Seed'])
  return { root, git, store: new StateStore(root) }
}

async function task(
  store: InstanceType<typeof StateStore>,
  id: string,
  status: Record<string, unknown>,
) {
  const directory = join(store.directory, 'delegations', id)
  await mkdir(directory, { recursive: true })
  await atomicJson(join(directory, 'status.json'), { id, ...status })
  return directory
}

const ids = {
  complete: '00000000-0000-4000-8000-000000000001',
  stale: '00000000-0000-4000-8000-000000000002',
  recent: '00000000-0000-4000-8000-000000000003',
  live: '00000000-0000-4000-8000-000000000004',
}

test('the sweep removes storage of exited processes and keeps its own', async () => {
  const own = await temporaryDirectory('workspace')
  const abandoned = join(temporaryRoot(), 'processes', `${await exitedPid()}-AbCdEf`)
  await mkdir(join(abandoned, 'workspace-XyZ123'), { recursive: true })
  const report = await sweepTemporary({ retentionMs })
  assert.ok(report.removed.includes(abandoned))
  await missing(abandoned)
  await access(own)
})

test('task copies survive only while their task can resume', async (t) => {
  const { root, store } = await repository(t)
  const owner = (taskId: string) => ({ projectRoot: root, stateDirectory: store.directory, taskId })
  const pid = await exitedPid()
  const owned = async (taskId: string) => {
    const path = await taskDirectory('workspace', owner(taskId))
    const record = JSON.parse(await readFile(`${path}.owner.json`, 'utf8'))
    await writeFile(`${path}.owner.json`, JSON.stringify({ ...record, pid }))
    return path
  }
  const recent = await owned(ids.recent)
  await task(store, ids.recent, { status: 'needs_attention', updatedAt: new Date().toISOString() })
  await atomicJson(join(store.directory, 'delegations', ids.recent, 'workspace.json'), {
    workspace: recent,
  })
  const stale = await owned(ids.stale)
  const old = new Date(Date.now() - 3 * 24 * hour).toISOString()
  await task(store, ids.stale, { status: 'needs_attention', updatedAt: old, candidate: stale })
  const finished = await owned(ids.complete)
  await task(store, ids.complete, { status: 'complete', updatedAt: new Date().toISOString() })
  const orphan = await taskDirectory('workspace', {
    projectRoot: join(root, 'deleted'),
    stateDirectory: store.directory,
    taskId: ids.live,
  })
  await writeFile(`${orphan}.owner.json`, JSON.stringify({ ...owner(ids.live), pid }))
  await sweepTemporary({ retentionMs })
  await access(recent)

  for (const path of [stale, finished, orphan]) {
    await missing(path)
    await missing(`${path}.owner.json`)
  }
})

test('legacy copies are removed after retention unless a retained task names them', async () => {
  const old = (Date.now() - 3 * 24 * hour) / 1000
  const kept = join(tmpdir(), 'pi-workspace-Keep01')
  const removed = join(tmpdir(), 'pi-workspace-Gone01')
  const young = join(tmpdir(), 'pi-command-Young1')

  for (const path of [kept, removed, young]) {
    await mkdir(path)
  }

  await utimes(kept, old, old)
  await utimes(removed, old, old)
  await sweepTemporary({ retentionMs, legacyReferences: new Set(['pi-workspace-Keep01']) })
  await access(kept)
  await access(young)
  await missing(removed)
})

test('cleanup removes finished and expired worktrees and keeps live or recent work', async (t) => {
  const { root, git, store } = await repository(t)
  const worktree = async (id: string) => {
    const path = join(store.directory, 'worktrees', id)
    await mkdir(join(store.directory, 'worktrees'), { recursive: true })
    await git(['worktree', 'add', '--quiet', '-b', `pi/${id}`, '--', path, 'main'])
    return path
  }
  const now = new Date().toISOString()
  const old = new Date(Date.now() - 3 * 24 * hour).toISOString()
  const finished = await worktree(ids.complete)
  await task(store, ids.complete, { status: 'complete', updatedAt: now })
  const expired = await worktree(ids.stale)
  await writeFile(join(expired, 'value.txt'), 'unfinished candidate edit\n')
  const staleDirectory = await task(store, ids.stale, { status: 'needs_attention', updatedAt: old })
  const recent = await worktree(ids.recent)
  await task(store, ids.recent, { status: 'needs_attention', updatedAt: now })
  const live = await worktree(ids.live)
  await task(store, ids.live, { status: 'running', updatedAt: old, pid: process.pid })
  const baseline = join(store.directory, 'baselines', `${ids.complete}-baseline`)
  await mkdir(join(store.directory, 'baselines'))
  await git(['worktree', 'add', '--quiet', '--detach', '--', baseline, 'main'])
  const stamp = (Date.now() - 7 * hour) / 1000
  await utimes(baseline, stamp, stamp)
  const liveBaseline = join(store.directory, 'baselines', `${ids.live}-baseline`)
  await git(['worktree', 'add', '--quiet', '--detach', '--', liveBaseline, 'main'])
  await utimes(liveBaseline, stamp, stamp)

  const preview = await pruneProject(store, { retentionMs, dryRun: true })
  assert.deepEqual(preview.worktrees.sort(), [finished, expired].sort())
  await access(finished)

  const report = await cleanup(store, { retentionMs })
  assert.deepEqual(report.worktrees.sort(), [finished, expired].sort())
  assert.deepEqual(report.baselines, [baseline])
  assert.deepEqual(report.expired, [ids.stale])
  assert.ok(report.branches.includes(`pi/${ids.complete}`))

  for (const path of [finished, expired, baseline]) {
    await missing(path)
  }

  for (const path of [recent, live, liveBaseline]) {
    await access(path)
  }

  const patch = await readFile(join(staleDirectory, 'expired.patch'), 'utf8')
  assert.match(patch, /\+unfinished candidate edit/)
  const status = JSON.parse(await readFile(join(staleDirectory, 'status.json'), 'utf8'))
  assert.equal(status.status, 'needs_attention')
  assert.equal(status.candidate, undefined)
  assert.match(status.error, /expired after 48 hours.*expired\.patch/)
  assert.equal(await git(['branch', '--list', `pi/${ids.complete}`]), '')
  assert.match(await git(['worktree', 'list']), new RegExp(ids.recent))
  assert.equal(root, store.projectRoot)
})

test('a resume after expiry reports it instead of rebuilding from the base', async (t) => {
  const { root, store } = await repository(t)
  const directory = await task(store, ids.stale, {
    status: 'needs_attention',
    updatedAt: new Date().toISOString(),
  })
  await atomicJson(join(directory, 'request.json'), {
    id: ids.stale,
    root,
    kind: 'research',
    task: 'Inspect',
    writePaths: [],
  })
  await atomicJson(join(directory, 'expired.json'), { reason: 'Retained work expired.' })
  const state = await runDelegation(store, ids.stale, new AbortController().signal, async () => {
    throw new Error('An expired task must not start a coordinator')
  })
  assert.equal(state.status, 'needs_attention')
  assert.equal(state.error, 'Retained work expired.')
})
