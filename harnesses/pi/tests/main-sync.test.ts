import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { branchRepository } from './branch-support.ts'
import { StateStore } from '../src/state.ts'
import { gitCommand } from '../src/git-branches.ts'
import { registerMainSync, syncMain } from '../src/main-sync.ts'
import { captureSession } from './session-support.ts'
import { setTimeout as delay } from 'node:timers/promises'

test('idle host fast-forwards main from another worktree without a model call', async (t) => {
  const { root, directory, remote, initial } = await branchRepository(t)
  const feature = join(directory, 'feature')
  await gitCommand(root, ['worktree', 'add', '-b', 'feature', feature])
  const writer = join(directory, 'writer')
  await gitCommand(root, ['worktree', 'add', '--detach', writer])
  const push = async (content: string) => {
    await writeFile(join(writer, 'src/one.js'), content)
    await gitCommand(writer, ['commit', '-am', 'Update the remote'])
    await gitCommand(writer, ['push', remote, 'HEAD:main'])
    return gitCommand(writer, ['rev-parse', 'HEAD'])
  }
  const first = await push('export const base = 4\n')
  await writeFile(join(root, 'src/two.js'), 'local work\n')
  const { session, runtime } = await captureSession(
    feature,
    directory,
    [
      (pi) => {
        registerMainSync(pi)
      },
    ],
    async () => {
      throw new Error('Sync must never invoke the model')
    },
  )

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await gitCommand(root, ['rev-parse', 'HEAD'])) === first) {
        break
      }

      await delay(50)
    }

    assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), first)
    assert.equal(await gitCommand(feature, ['rev-parse', 'HEAD']), initial)
    assert.equal(await readFile(join(root, 'src/two.js'), 'utf8'), 'local work\n')
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }

  const sync = (force: boolean, idle = true) =>
    syncMain(root, AbortSignal.timeout(10000), () => idle, force)
  const second = await push('export const base = 5\n')
  await sync(false)
  assert.equal(await gitCommand(root, ['rev-parse', 'refs/remotes/origin/main']), first)
  await sync(true, false)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), first)
  await writeFile(join(root, 'src/one.js'), 'overlapping edit\n')
  assert.match((await sync(false))!, /safely/)
  assert.equal(await readFile(join(root, 'src/one.js'), 'utf8'), 'overlapping edit\n')
  await gitCommand(root, ['restore', 'src/one.js'])
  await gitCommand(root, ['add', 'src/two.js'])
  assert.match((await sync(false))!, /staged/)
  await gitCommand(root, ['restore', '--staged', 'src/two.js'])
  await gitCommand(root, ['config', 'pi.syncMain', 'false'])
  await sync(false)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), first)
  await gitCommand(root, ['config', 'pi.syncMain', 'true'])
  const unlock = await new StateStore(root).lock()

  try {
    assert.match((await sync(false))!, /workflow owns local main/)
    assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), first)
  } finally {
    await unlock()
  }

  await sync(false)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), second)
  await gitCommand(root, ['commit', '-am', 'Local commit'])
  const ahead = await gitCommand(root, ['rev-parse', 'HEAD'])
  await push('export const base = 6\n')
  assert.match((await sync(true))!, /diverged/)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), ahead)
})

test('unoccupied main advances and offline refresh backs off', async (t) => {
  const { root, remote, initial } = await branchRepository(t)
  await gitCommand(root, ['switch', '-c', 'work'])
  await writeFile(join(root, 'src/one.js'), 'export const next = 8\n')
  await gitCommand(root, ['commit', '-am', 'Advance upstream'])
  await gitCommand(root, ['push', remote, 'HEAD:main'])
  const tip = await gitCommand(root, ['rev-parse', 'HEAD'])
  const sync = (force = false) => syncMain(root, AbortSignal.timeout(10000), () => true, force)
  await Promise.all([sync(), sync()])
  assert.equal(await gitCommand(root, ['rev-parse', 'main']), tip)
  assert.equal(await gitCommand(root, ['symbolic-ref', '--short', 'HEAD']), 'work')
  await gitCommand(root, ['remote', 'set-url', 'origin', join(root, 'missing.git')])
  await assert.rejects(sync(), /Git fetch failed/)
  assert.match((await sync())!, /unsuccessful fetch/)
  assert.equal(await gitCommand(root, ['rev-parse', 'main']), tip)
  assert.notEqual(tip, initial)
})

test('automatic main sync respects checkout filters on the incoming revision', async (t) => {
  const { root, directory, remote, initial } = await branchRepository(t)
  const writer = join(directory, 'publisher')
  await gitCommand(root, ['worktree', 'add', '--detach', writer])
  await writeFile(join(writer, '.gitattributes'), '*.blob filter=storage\n')
  await writeFile(join(writer, 'image.blob'), 'storage pointer\n')
  await gitCommand(writer, ['add', '.gitattributes', 'image.blob'])
  await gitCommand(writer, ['commit', '-m', 'Store images through a checkout filter'])
  await gitCommand(writer, ['push', remote, 'HEAD:main'])
  assert.match((await syncMain(root, AbortSignal.timeout(10000), () => true))!, /checkout filter/)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), initial)
})
