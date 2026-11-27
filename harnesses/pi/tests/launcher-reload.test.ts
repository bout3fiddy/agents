import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { install } from '../scripts/install.ts'
import { harnessRoot } from '../src/project.ts'

test('installed Pi reloads new tools under the active role policy', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-launcher-reload-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project')
  await mkdir(root)
  const { destination, wrapper } = await install(join(base, 'private'))
  const probe = join(base, 'probe.ts')
  const receipt = join(base, 'probe.json')
  const source = (generation: number) =>
    "import {writeFileSync} from 'node:fs'\nexport default function(pi) {\n" +
    "pi.registerCommand('reload-fixture',{handler: async (_a,ctx) => {await ctx.reload()}})\n" +
    (generation === 2
      ? "pi.registerTool({name:'future_probe',description:'test',label:'test'," +
        "parameters:{type:'object',properties:{}},execute:async()=>({content:[]})})\n"
      : '') +
    'pi.on("session_start", (e,ctx)=>writeFileSync(' +
    JSON.stringify(receipt) +
    ',JSON.stringify({reason:e.reason, registered:pi.getAllTools().map(x=>x.name),' +
    'model:ctx.model?.id,thinking:pi.getThinkingLevel(),active:pi.getActiveTools()})))}'
  await writeFile(probe, source(1))
  const chosen = 'openai-codex/gpt-6.1-sol'
  const args = ['--mode', 'rpc', '--extension', probe, '--model', chosen, '--thinking', 'high']
  const child = spawn(wrapper, args, {
    cwd: root,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let diagnostics = ''
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk).slice(-1000)
  })
  const closed = once(child, 'close')
  t.after(async () => {
    child.stdin.end()
    await closed
  })
  const load = async (reason: string) => {
    const deadline = Date.now() + 15000

    while (Date.now() < deadline && child.exitCode === null) {
      const raw = await readFile(receipt, 'utf8').catch(() => '')

      if (raw) {
        const event = JSON.parse(raw)

        if (event.reason === reason) {
          return event
        }
      }

      await delay(50)
    }

    throw new Error('Missing ' + reason + ' receipt: ' + diagnostics)
  }
  const first = await load('startup')
  assert.deepEqual([`openai-codex/${first.model}`, first.thinking], [chosen, 'high'])
  assert.ok(first.active.includes('job_start'))
  assert.ok(!first.registered.includes('future_probe'))

  // Simulate a completed install pointing at another release. Extension reload cannot re-exec Pi.
  const installFile = join(destination, 'harness-install.json')
  const previous = JSON.parse(await readFile(installFile, 'utf8'))
  const replacement = {
    ...previous,
    source: join(base, 'next release'),
    pi: { version: 'fixture-next', entry: join(base, 'next release/dist/cli.js') },
  }
  await writeFile(installFile, JSON.stringify(replacement))
  await writeFile(probe, source(2))
  child.stdin.write(JSON.stringify({ type: 'prompt', message: '/reload-fixture' }) + '\n')
  const next = await load('reload')
  assert.deepEqual([next.model, next.thinking], [first.model, first.thinking])
  assert.ok(next.registered.includes('future_probe'))
  assert.ok(next.active.includes('job_start'))
  assert.ok(!next.active.includes('future_probe'))
  const [runtimeFile] = await readdir(join(root, '.pi/traces/harness/runtime'))
  const loads = (await readFile(join(root, '.pi/traces/harness/runtime', runtimeFile!), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(loads.length, 2)
  const [startup, reload] = loads
  assert.equal(startup.launcherWarning, undefined)
  assert.equal(startup.piHost.entry, previous.pi.entry)
  assert.equal(startup.piHost.version, previous.pi.version)
  assert.deepEqual(reload.piHost, startup.piHost)
  assert.equal(reload.pid, startup.pid)
  assert.equal(reload.source, previous.source)
  assert.deepEqual(reload.expectedPi, replacement.pi)
  assert.ok(reload.launcherWarning.includes(replacement.source))
})

test('interactive exit and legacy resume identify the CLI and preserve the session', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi resume's ")))
  t.after(() => rm(base, { recursive: true, force: true }))
  const { destination, wrapper } = await install(join(base, 'private agent'))
  const root = join(base, 'project')
  await mkdir(root)
  const sessions = join(base, 'alternate session store')
  await mkdir(sessions, { recursive: true })
  const id = 'c9d1650a-23f4-4e31-8e1e-8d9c5ca6e8c3'
  const file = join(sessions, `saved_${id}.jsonl`)
  const timestamp = new Date().toISOString()
  const header = { type: 'session', version: 3, id, cwd: root, timestamp }
  await writeFile(file, JSON.stringify(header) + '\n')
  const pkg = '@earendil-works/pi-coding-agent'
  const global = join(base, 'global')
  await cp(join(harnessRoot, 'node_modules', pkg), global, { recursive: true })
  const manifest = JSON.parse(await readFile(join(global, 'package.json'), 'utf8'))
  const expectedVersion = manifest.version
  await symlink(join(harnessRoot, 'node_modules'), join(base, 'node_modules'))
  const globalEntry = join(global, manifest.bin.pi)
  await symlink(globalEntry, join(base, 'pi'))

  // Use the real interactive shutdown over pipes, with only terminal capabilities simulated.
  const terminal =
    'process.stdin.isTTY=true;process.stdout.isTTY=true;' +
    'process.stdout.columns=240;process.stdout.rows=30;'
  const quit = join(base, 'quit.ts')
  await writeFile(quit, "export default pi => pi.on('session_start', (_e,ctx) => ctx.shutdown())")
  const options = {
    cwd: root,
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: base,
      PATH: `${base}:${process.env.PATH}`,
      PI_CODING_AGENT_DIR: destination,
      PI_HARNESS_AGENT_DIR: destination,
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(terminal)}`,
    },
  }
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(command, args, {
      ...options,
      env: { ...options.env, ...env },
      encoding: 'utf8',
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(-2000))
    return result.stdout
  }
  const flags = ['--offline', '--extension', quit]
  const notices = join(harnessRoot, 'tests/launcher-notice-probe.ts')
  const output = run(
    wrapper,
    ['--session-dir', sessions, '--session', file, '--offline', '--extension', notices],
    {
      PI_PACKAGE_DIR: global,
    },
  )
  const command = /To resume this session:[^\n]*\n([^\n]+)/.exec(output)?.[1]
  assert.ok(command, output.slice(-3000))
  assert.match(command, /pi-harness/)
  const rendered = stripVTControlCharacters(await readFile(join(root, 'notices.txt'), 'utf8'))
  assert.ok(rendered.includes(`Restart with \`${command}\``))
  assert.match(rendered, /New version fixture-new is available/)
  const update = /Run (.+pi-harness' update)/.exec(rendered)?.[1]
  assert.ok(update, rendered)
  assert.match(run('/bin/sh', ['-c', `${update} --help`]), /Usage: pi-harness update/)
  run('/bin/sh', ['-c', `${command} "$@"`, 'resume', ...flags])
  manifest.version = '0.0.7'
  await writeFile(join(global, 'package.json'), JSON.stringify(manifest))
  const legacy = spawn('pi', ['--session-dir', sessions, '--session', id, '--offline'], options)
  let screen = ''
  let warned = false
  legacy.stdout.on('data', (chunk: Buffer) => {
    screen = (screen + chunk).slice(-32_768)

    if (!warned && screen.includes('Not running the installed harness launcher')) {
      warned = true
      legacy.stdin.end('/quit\r')
    }
  })
  const [status] = await once(legacy, 'close')
  assert.equal(status, 0, screen.slice(-1000))
  assert.ok(warned, screen.slice(-1000))
  const records = (await readFile(join(root, '.pi/traces/harness/runtime', `${id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 3)
  const [first, resumed, wrong] = records
  assert.notEqual(first.pid, resumed.pid)
  assert.deepEqual(first.piHost, resumed.piHost)
  assert.equal(first.piHost.version, expectedVersion)
  assert.equal(first.piHost.wrapper, wrapper)
  assert.equal(wrong.piHost.entry, globalEntry)
  assert.equal(wrong.piHost.version, manifest.version)
  assert.equal(wrong.expectedPi.version, expectedVersion)
  const restart = wrong.launcherWarning.split('Exit and run from this project: ')[1]
  assert.ok(restart?.includes('pi-harness'))
  assert.ok(run('/bin/sh', ['-c', `${restart} "$@"`, 'resume', ...flags]).includes(command))
})
