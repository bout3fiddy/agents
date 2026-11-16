import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireLock, type ReleaseLock } from '../src/lock.ts'
import { harnessRoot } from '../src/project.ts'

test('concurrent stale-lock contenders have exactly one owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-lock-contention-'))
  const path = join(root, 'workflow.lock')
  await writeFile(path, '2147483647')
  const inode = (await stat(path)).ino
  const contenders = await Promise.allSettled(Array.from({ length: 16 }, () => acquireLock(path)))
  const owners = contenders.filter((item) => item.status === 'fulfilled')

  try {
    assert.equal(owners.length, 1)

    for (const contender of contenders) {
      if (contender.status === 'rejected') {
        assert.match(String(contender.reason), /already running/)
      }
    }

    owners[0]!.value.assertHeld()
    assert.equal((await stat(path)).ino, inode)
  } finally {
    await Promise.all(owners.map((owner) => owner.value()))
    await rm(root, { recursive: true, force: true })
  }
})

test('a supervisor crash releases its kernel lock through pipe closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-lock-crash-'))
  const path = join(root, 'workflow.lock')
  const code = `
    import { acquireLock } from ${JSON.stringify(join(harnessRoot, 'src/lock.ts'))};
    await acquireLock(process.argv[1]);
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
      '--input-type=module',
      '-e',
      code,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let recovered: ReleaseLock | undefined

  try {
    const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
    assert.match(String(ready), /READY/)
    await assert.rejects(acquireLock(path), /already running/)
    child.kill('SIGKILL')
    await once(child, 'close')

    for (let attempt = 0; attempt < 50 && !recovered; attempt++) {
      try {
        recovered = await acquireLock(path)
      } catch (error) {
        assert.match(String(error), /already running/)
        await delay(20)
      }
    }

    assert.ok(recovered)
    recovered.assertHeld()
  } finally {
    child.kill('SIGKILL')
    await recovered?.()
    await rm(root, { recursive: true, force: true })
  }
})
