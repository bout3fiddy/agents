import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runSandboxed } from '../src/sandbox.ts'
import { safePath, writable } from '../src/paths.ts'
import { integrate, recoverIntegration } from '../src/integration.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { harnessRoot } from '../src/project.ts'

test('sandbox denies outside reads, writes, symlink escapes and network', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-isolation-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const secret = join(base, 'private.txt')
  await writeFile(secret, 'PRIVATE_MARKER')
  await symlink(secret, join(workspace, 'link'))
  const report = join(harnessRoot, 'reports', `isolation-${randomUUID()}.txt`)
  await mkdir(join(harnessRoot, 'reports'), { recursive: true })
  await writeFile(report, 'PRIVATE_REPORT_MARKER')
  const code = `
    const fs = require('fs');
    const net = require('net');
    for (const path of [process.argv[1], process.argv[2], 'link']) {
      try { fs.readFileSync(path); process.exit(2) } catch (e) {
        if (!['EPERM','EACCES'].includes(e.code)) throw e;
      }
    }
    try { fs.readdirSync('/opt/homebrew/etc'); process.exit(6) } catch (e) {
      if (!['EPERM','EACCES'].includes(e.code)) throw e;
    }
    try { fs.writeFileSync(process.argv[1], 'bad'); process.exit(3) } catch (e) {
      if (!['EPERM','EACCES'].includes(e.code)) throw e;
    }
    fs.writeFileSync('allowed.txt', 'ok');
    const socket = net.connect(443, '1.1.1.1');
    socket.on('connect', () => process.exit(4));
    socket.on('error', e => {
      if (!['EPERM','EACCES'].includes(e.code)) process.exit(5);
      console.log('boundaries enforced');
    });
  `

  try {
    const result = await runSandboxed(workspace, ['node', '-e', code, secret, report], 5000)
    assert.equal(result.exitCode, 0, result.output)
    assert.match(result.output, /boundaries enforced/)
    assert.equal(await readFile(secret, 'utf8'), 'PRIVATE_MARKER')
    await assert.rejects(safePath(workspace, 'link'), /Symbolic/)
    await assert.rejects(safePath(workspace, '../private.txt'), /traversal/)
    assert.equal(writable('.pi/harness.json', ['**']), false)
  } finally {
    await rm(report, { force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test('private paths and policy writes reject case aliases on every filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-case-alias-'))

  try {
    for (const path of [
      '.ENV',
      '.Env.local',
      '.GIT/hooks/probe',
      'Node_Modules/x',
      '.NPMRC',
      'secret.KEY',
      '.ſsh/id',
      'node_moduleſ/pkg/index.js',
      'ſecrets.json',
      '.ßh/id',
      '.ẞh/config',
      '.harneẞ/state.json',
    ]) {
      await assert.rejects(safePath(root, path), /Private/)
    }

    for (const path of ['.PI/harness.json', '.Pi', 'agents.override.md']) {
      assert.equal(writable(path, ['**']), false, path)
    }

    await mkdir(join(root, 'samples'))
    await assert.rejects(safePath(root, 'ſamples/file'), /spelling aliases/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commands terminate on timeout and cancellation and bound output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-cancel-'))

  try {
    const timed = await runSandboxed(workspace, ['node', '-e', 'setInterval(()=>{},1000)'], 200)
    assert.equal(timed.timedOut, true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    const cancelled = await runSandboxed(
      workspace,
      ['node', '-e', 'setInterval(()=>{},1000)'],
      5000,
      controller.signal,
    )
    clearTimeout(timer)
    assert.equal(cancelled.aborted, true)
    const large = await runSandboxed(workspace, ['node', '-e', 'console.log("a".repeat(100000))'])
    assert.equal(large.truncated, true)
    assert.ok(large.output.length <= 64000)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('cancellation during asynchronous command setup remains observable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-setup-abort-'))

  try {
    const controller = new AbortController()
    const pending = runSandboxed(
      workspace,
      ['node', '-e', 'setInterval(()=>{},1000)'],
      5000,
      controller.signal,
    )
    queueMicrotask(() => controller.abort())
    const result = await pending
    assert.equal(result.aborted, true)
    assert.ok(result.durationMs < 2000)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('escaped descendants cannot hold command completion or cancellation open', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-detached-'))
  const code = `
    const fs = require('fs');
    const child = require('child_process').spawn('/bin/sleep', ['20'], {
      detached: true, stdio: 'inherit'
    });
    fs.writeFileSync('detached.pid', String(child.pid));
    child.unref();
    if (process.argv[1] !== 'exit') setInterval(() => {}, 1000);
  `

  try {
    for (const mode of ['exit', 'timeout', 'abort']) {
      const controller = new AbortController()
      const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 200) : undefined

      try {
        const result = await runSandboxed(
          workspace,
          ['node', '-e', code, mode],
          mode === 'timeout' ? 200 : 5000,
          controller.signal,
        )
        assert.equal(result.exitCode, null)
        assert.ok(result.durationMs < 3000, `Unbounded ${mode}: ${result.durationMs}`)
        assert.match(result.output, /detached descendants unsupported/)
      } finally {
        clearTimeout(timer)
        const pid = Number(await readFile(join(workspace, 'detached.pid'), 'utf8'))

        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
        }
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('integration journal recovers partial writes and preserves concurrent edits', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-recovery-'))
  const root = join(base, 'project')
  await mkdir(root)
  const store = new StateStore(root, join(base, 'state'))
  const encoded = (value: string) => Buffer.from(value).toString('base64')

  try {
    await writeFile(join(root, 'a.txt'), 'after')
    await writeFile(join(root, 'b.txt'), 'before')
    await atomicJson(join(store.directory, 'integration.json'), {
      status: 'pending',
      edits: ['a.txt', 'b.txt'].map((path) => ({
        path,
        before: encoded('before'),
        after: encoded('after'),
      })),
    })
    assert.equal(await recoverIntegration(store), true)
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'after')
    assert.equal(await recoverIntegration(store), false)
    await assert.rejects(
      integrate(
        store,
        new Map([['a.txt', Buffer.from('before')]]),
        new Map([['a.txt', Buffer.from('new')]]),
        ['**'],
      ),
      /Concurrent/,
    )
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'after')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('sandbox npx runs installed tools and reports missing packages offline', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-offline-npx-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'package.json'), '{"name":"fixture","version":"1.0.0"}')
  const bin = join(workspace, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'fixture-check'), '#!/bin/sh\necho fixture-check\nexit 17\n', {
    mode: 0o755,
  })
  const installed = await runSandboxed(workspace, ['npx', 'fixture-check'], 10000)
  assert.equal(installed.exitCode, 17, installed.output)
  assert.match(installed.output, /fixture-check/)
  const missing = await runSandboxed(workspace, ['npx', '--yes', 'prettier', '--version'], 10000)
  assert.equal(missing.timedOut, false)
  assert.equal(missing.exitCode, 1, missing.output)
  assert.match(missing.output, /ENOTCACHED/i)
})
