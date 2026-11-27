import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dispatcher, runWorkerProcess } from '../src/dispatch.ts'
import { harnessRoot, loadProject } from '../src/project.ts'
import { atomicJson } from '../src/state.ts'
import {
  recordTrustDecision,
  resolveExecution,
  runWorkerCommand,
  type ExecutionPolicy,
} from '../src/worker-execution.ts'
import { fixture, hashes, checkpoint } from './support.ts'

const loader = join(harnessRoot, 'node_modules/tsx/dist/loader.mjs')
const sandbox = pathToFileURL(join(harnessRoot, 'src/sandbox.ts')).href
const execution = pathToFileURL(join(harnessRoot, 'src/worker-execution.ts')).href
const trusted: ExecutionPolicy = { mode: 'trusted-local', reason: 'enrolled' }

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

async function cancelCommand(t: TestContext, bridge: boolean, local = false) {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const helper = join(base, 'worker.mts')
  const code = `
    import { spawn } from 'node:child_process'
    import { writeFile } from 'node:fs/promises'
    import { runSandboxed, workerAbortSignal } from ${JSON.stringify(sandbox)}
    import { runWorkerCommand } from ${JSON.stringify(execution)}
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
      const workspace = ${JSON.stringify(root)}
      const result = ${local}
        ? await runWorkerCommand(${JSON.stringify(trusted)}, { workspace, argv: command })
        : await runSandboxed(workspace, command)
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
  assert.equal(result.runner, local ? 'host' : 'sandbox')
}

test('cancelling a worker stops its independently grouped sandbox command', async (t) => {
  await cancelCommand(t, false)
})

test('cancelling a worker group lets its MCP bridge stop sandbox commands', async (t) => {
  await cancelCommand(t, true)
})

test('cancelling a worker stops its trusted local command', async (t) => {
  await cancelCommand(t, false, true)
})

test('cancelling a worker group lets its MCP bridge stop trusted local commands', async (t) => {
  await cancelCommand(t, true, true)
})

test('a trusted local command and its descendant stop at the timeout', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const result = await runWorkerCommand(trusted, {
    workspace: root,
    argv: ['sh', '-c', 'sleep 30 & echo $! > descendant.pid; wait'],
    timeoutMs: 400,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.runner, 'host')
  assert.ok(result.durationMs < 3000, `Unbounded timeout: ${result.durationMs}`)
  await assertStopped(Number(await readFile(join(root, 'descendant.pid'), 'utf8')))
})

test('the Claude bridge runs commands under the host decision and its revocation', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const agent = join(item.base, 'agent')
  const sources = { environment: { PI_HARNESS_AGENT_DIR: agent } }
  const files = {
    'pkg/package-lock.json': JSON.stringify({
      packages: {
        '': { dependencies: { 'pinned-sdk': '1.2.3' } },
        'node_modules/pinned-sdk': { version: '1.2.3' },
      },
    }),
    'pkg/probe.cjs': "console.log(require('pinned-sdk/package.json').version)\n",
    'pkg/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
    'node_modules/pinned-sdk/package.json': '{"version":"9.9.9"}',
  }

  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(item.root, name)), { recursive: true })
    await writeFile(join(item.root, name), content)
  }

  await recordTrustDecision(item.root, 'trusted-local', sources)
  const project = await loadProject(item.root, undefined, (root) =>
    resolveExecution(root, false, sources),
  )
  assert.equal(project.execution?.mode, 'trusted-local')
  const requestPath = join(item.base, 'request.json')
  const outputPath = join(item.base, 'output.json')
  await atomicJson(requestPath, {
    role: 'implementer',
    implementerModel: 'fable',
    task: 'Bridge execution test',
    workspace: item.root,
    project,
    checkpoint: item.checkpoint,
    model: 'claude-fable-5-2',
    outputPath,
    baseline: {},
  })
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  const client = new Client({ name: 'harness-test', version: '1' })
  t.after(() => client.close())
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', loader, join(harnessRoot, 'src/claude-tools.ts'), requestPath],
      env: {
        ...Object.fromEntries(inherited),
        PI_HARNESS_AGENT_DIR: agent,
        PI_HARNESS_ISOLATION: '',
      },
      stderr: 'pipe',
    }),
  )
  const run = async (argv: string[]) => {
    const response = await client.callTool({ name: 'run_command', arguments: { argv } })
    const content = response.content as { type: string; text: string }[]
    return JSON.parse(content.at(-1)!.text)
  }
  const listed = await client.listTools()
  const description = listed.tools.find((tool) => tool.name === 'run_command')?.description
  assert.match(description ?? '', /normal local command in a disposable copy/)
  const local = await run(['node', 'pkg/probe.cjs'])
  assert.equal(local.exitCode, 0, local.output)
  assert.equal(local.output.trim(), '1.2.3')
  assert.equal(local.execution, 'trusted-local')
  assert.equal(local.runner, 'host')

  // The running bridge holds the request frozen at dispatch and still obeys the host's registry.
  await recordTrustDecision(item.root, 'unknown', sources)
  const canary = join(item.base, 'host-canary')
  const write = `require('fs').writeFileSync(${JSON.stringify(canary)}, 'escaped')`
  const revoked = await run(['node', '-e', write])
  assert.equal(revoked.execution, 'isolated')
  assert.equal(revoked.runner, 'sandbox')
  assert.notEqual(revoked.exitCode, 0)
  await assert.rejects(readFile(canary), /ENOENT/)
  const evidence = JSON.parse(await readFile(`${outputPath}.tools.json`, 'utf8'))
  assert.deepEqual(
    evidence.commands.map((command: { runner: string }) => command.runner),
    ['host', 'sandbox'],
  )
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
    checkpoint: checkpoint(),
    model: 'openai-codex/gpt-6.1-sol',
    baseline: await hashes(root),
  }
  const running = dispatcher(store.directory)(request, controller.signal)
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
