import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { dispatcher, runWorkerProcess } from '../src/dispatch.ts'
import { harnessRoot } from '../src/project.ts'
import { fixture, hashes } from './support.ts'

const loader = join(harnessRoot, 'node_modules/tsx/dist/loader.mjs')
const sandbox = pathToFileURL(join(harnessRoot, 'src/sandbox.ts')).href

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      return Number(await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    await delay(20)
  }

  throw new Error('Sandbox command failed to start within five seconds')
}

async function assertStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return
      }

      throw error
    }

    await delay(20)
  }

  assert.fail(`Sandbox command ${pid} survived worker cancellation`)
}

async function cancelCommand(t: TestContext, bridge: boolean) {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const helper = join(base, 'worker.mts')
  const code = `
    import { spawn } from 'node:child_process'
    import { writeFile } from 'node:fs/promises'
    import { runSandboxed, workerAbortSignal } from ${JSON.stringify(sandbox)}
    if (${bridge} && process.argv[2] !== 'bridge') {
      spawn(process.execPath, ['--import', ${JSON.stringify(loader)},
        ${JSON.stringify(helper)}, 'bridge'], { stdio: 'inherit', env: process.env })
      await new Promise(resolve => workerAbortSignal.addEventListener('abort', resolve))
      process.exit(0)
    } else {
      const command = [
        'node', '-e',
        'require("fs").writeFileSync("command.pid", String(process.pid));' +
        'setInterval(() => {}, 1000)',
      ]
      const result = await runSandboxed(${JSON.stringify(root)}, command)
      await writeFile(${JSON.stringify(join(base, 'command-result.json'))}, JSON.stringify(result))
    }
  `
  await writeFile(helper, code)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const running = runWorkerProcess(['--import', loader, helper], 15000, controller.signal)
  const pid = await waitForPid(join(root, 'command.pid'))
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  })
  controller.abort()
  await assert.rejects(running, /Worker cancelled/)
  await assertStopped(pid)
  const result = JSON.parse(await readFile(join(base, 'command-result.json'), 'utf8'))
  assert.equal(result.aborted, true)
}

test('cancelling a worker stops its independently grouped sandbox command', async (t) => {
  await cancelCommand(t, false)
})

test('cancelling a worker group lets its MCP bridge stop sandbox commands', async (t) => {
  await cancelCommand(t, true)
})

test('worker termination has a bounded fallback for an unresponsive process', async () => {
  const started = Date.now()
  await assert.rejects(
    runWorkerProcess(['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], 200),
    /execution time budget/,
  )
  assert.ok(Date.now() - started < 5000)
})

test('cancellation during dispatcher setup prevents model process launch', async (t) => {
  const { base, root, store } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const controller = new AbortController()
  const request = {
    role: 'task-worker' as const,
    task: 'Must never reach a model',
    workspace: root,
    project: { root, checks: [], databasePaths: [], instrumentationPaths: [] },
    checkpoint: (await store.checkpoint())!,
    model: 'openai-codex/gpt-6.1-sol',
    baseline: await hashes(root),
  }
  const running = dispatcher(store)(request, controller.signal)
  controller.abort(new Error('setup cancellation'))
  await assert.rejects(running, /setup cancellation/)
  const attempts = await readdir(join(store.directory, 'attempts'))
  assert.equal(
    attempts.some((name) => name.endsWith('.sessions')),
    false,
  )
  const status = attempts.find((name) => name.endsWith('.status'))!
  assert.equal(
    JSON.parse(await readFile(join(store.directory, 'attempts', status), 'utf8')).status,
    'cancelled',
  )
})
