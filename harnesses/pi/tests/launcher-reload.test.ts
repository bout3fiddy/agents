import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { renameSync } from 'node:fs'
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

// Real interactive startup and shutdown over pipes with a private terminal and network fixture.
const terminal =
  'process.stdin.isTTY=true;process.stdout.isTTY=true;' +
  'process.stdout.columns=240;process.stdout.rows=30;' +
  'const fetch=async url=>String(url).endsWith("/api/latest-version")?' +
  'Response.json({version:"999.0.0"}):new Response(null,{status:404});' +
  'Object.defineProperty(globalThis,"fetch",{get:()=>fetch,set:()=>{}});'
const terminalOptions = `--import=data:text/javascript,${encodeURIComponent(terminal)}`

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
  const message = {
    type: 'message',
    id: '12345678',
    parentId: null,
    timestamp,
    message: { role: 'user', content: 'Keep this exact conversation.', timestamp: Date.now() },
  }
  await writeFile(file, [header, message].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const pkg = '@earendil-works/pi-coding-agent'
  const global = join(base, 'global')
  await cp(join(harnessRoot, 'node_modules', pkg), global, { recursive: true })
  const manifest = JSON.parse(await readFile(join(global, 'package.json'), 'utf8'))
  const expectedVersion = manifest.version
  await symlink(join(harnessRoot, 'node_modules'), join(base, 'node_modules'))

  // The default gate is hermetic. The same journey can target the real global 1.6.1 binary.
  const globalEntry = process.env.PI_TEST_GLOBAL_PI
    ? await realpath(process.env.PI_TEST_GLOBAL_PI)
    : join(global, manifest.bin.pi)
  await symlink(globalEntry, join(base, 'pi'))

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
      PI_OFFLINE: '',
      PI_SKIP_VERSION_CHECK: '',
      NODE_OPTIONS: terminalOptions,
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

  // Pi renders the same argv it hands to the terminal. Check the exact file, not just the ID.
  const operands = run('/bin/sh', ['-c', `printf '%s\\0' ${command}`]).split('\0')
  assert.equal(operands[0], wrapper)
  assert.equal(operands[operands.indexOf('--session') + 1], file)

  // Only the fixture's manifest changes. An explicitly supplied global CLI is always read-only.
  manifest.version = '1.6.1'
  await writeFile(join(global, 'package.json'), JSON.stringify(manifest))
  const globalArgs = ['--session-dir', sessions, '--session', id]
  const manual = run('pi', [...globalArgs, '--extension', quit])
  const correction = manual.split('For this harness chat, use this instead:\n')[1]?.trim()
  assert.ok(correction, manual.slice(-2000))
  assert.match(manual, /To resume this session:[^\n]*\npi /)
  assert.doesNotMatch(manual, /999\.0\.0|Exit and run from this project/)
  assert.ok(
    run('/bin/sh', ['-c', `cd .. && ${correction} "$@"`, 'resume', ...flags]).includes(command),
  )
  assert.equal(spawnSync('mkfifo', [join(root, 'gate')]).status, 0)
  const legacy = spawn('pi', globalArgs, options)
  let screen = ''
  let stage = 0
  const timeout = setTimeout(() => legacy.stdin.end('/quit\r'), 15_000)
  legacy.stdout.on('data', (chunk: Buffer) => {
    screen = (screen + stripVTControlCharacters(chunk.toString())).slice(-65_536)

    if (screen.includes('Not running the installed harness launcher/release')) {
      legacy.stdin.end('/quit\r')
    } else if (stage === 0 && screen.includes('Global Pi · /pih')) {
      stage++
      legacy.stdin.write('/reload\r')
    } else if (stage === 1 && screen.includes('Reloaded keybindings')) {
      stage++
      renameSync(file, file + '.held')
      legacy.stdin.write('/pih\r')
    } else if (stage === 2 && screen.includes('Cannot verify the saved chat')) {
      stage++
      renameSync(file + '.held', file)
      legacy.stdin.write('!echo holding; cat gate; exit 7\r')
    } else if (stage === 3 && screen.includes('holding') && screen.includes('cat gate')) {
      stage++
      legacy.stdin.write('/pih\r')
    } else if (stage === 4 && screen.includes('Finish the current work')) {
      stage++
      void writeFile(join(root, 'gate'), 'shell finished\n')
    } else if (stage === 5 && screen.includes('shell finished') && screen.includes('(exit 7)')) {
      stage++
      legacy.stdin.write('/pih\r')
    } else if (
      stage === 6 &&
      screen.includes('Reopening this chat') &&
      screen.slice(screen.lastIndexOf('Reopening this chat')).includes('999.0.0')
    ) {
      stage++
      legacy.stdin.end('/quit\r')
    }
  })
  const [status] = await once(legacy, 'close')
  clearTimeout(timeout)
  assert.equal(status, 0, `stage ${stage}: ${screen.slice(-3000)}`)
  assert.equal(stage, 7, screen.slice(-3000))
  assert.ok(screen.includes(command))
  const [beforeRecovery, afterRecovery] = screen.split('Reopening this chat')
  assert.doesNotMatch(beforeRecovery!, /999\.0\.0|Run pi update|Exit and run from this project/)
  assert.match(afterRecovery!, /999\.0\.0/)
  const records = (await readFile(join(root, '.pi/traces/harness/runtime', `${id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 7)
  const [first, resumed, , corrected, wrong, reloaded, recovered] = records
  assert.deepEqual(corrected.piHost, first.piHost)
  const persisted = await readFile(file, 'utf8')
  assert.ok(persisted.includes(recovered.loadId))
  assert.ok(persisted.includes('Keep this exact conversation.'))
  assert.ok(persisted.includes('shell finished'))
  assert.deepEqual(wrong.piHost, reloaded.piHost)
  assert.deepEqual(first.piHost, recovered.piHost)
  assert.equal(reloaded.pid, recovered.pid)
  assert.equal(recovered.launcherWarning, undefined)
  assert.notEqual(first.pid, resumed.pid)
  assert.deepEqual(first.piHost, resumed.piHost)
  assert.equal(first.piHost.version, expectedVersion)
  assert.equal(first.piHost.wrapper, wrapper)
  assert.equal(wrong.piHost.entry, globalEntry)
  assert.equal(wrong.piHost.version, manifest.version)
  assert.equal(wrong.expectedPi.version, expectedVersion)
  assert.ok(wrong.launcherWarning)
})

test('an older wrapper reopens the original chat in the newly installed release', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-old-wrapper-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const project = join(base, 'original project')
  await mkdir(project)
  const id = 'b2967ad2-cdc3-4248-b4c9-19825ea5ecb9'
  const timestamp = new Date().toISOString()
  const file = join(base, 'original.jsonl')
  await writeFile(
    file,
    JSON.stringify({ type: 'session', version: 3, id, cwd: project, timestamp }) + '\n',
  )
  const { destination, wrapper } = await install(join(base, 'agent'))
  const release = join(base, 'new release')
  await mkdir(release)

  for (const part of [
    'src',
    'scripts',
    'roles',
    'prompts',
    'guidelines',
    'package.json',
    'package-lock.json',
  ]) {
    await cp(join(harnessRoot, part), join(release, part), { recursive: true })
  }

  await symlink(join(harnessRoot, 'node_modules'), join(release, 'node_modules'))
  const old = spawn(wrapper, ['--session', file, '--offline'], {
    cwd: base,
    env: { ...process.env, HOME: base, NODE_OPTIONS: terminalOptions },
    timeout: 25_000,
  })
  const closed = once(old, 'close')
  const timeout = setTimeout(() => old.stdin.end('/quit\r'), 18_000)
  let screen = ''
  let stage = 0

  for await (const chunk of old.stdout) {
    screen = (screen + stripVTControlCharacters(chunk.toString())).slice(-32_768)

    if (stage === 0 && screen.includes('orchestrator')) {
      stage++
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/install.ts', destination],
        {
          cwd: release,
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
      assert.equal(result.status, 0, result.stderr)
    } else if (stage === 1 && screen.includes('Older harness host · /pih')) {
      stage++
      old.stdin.write('/pih\r')
    } else if (stage === 2 && screen.split('Reopening this chat')[1]?.includes('orchestrator')) {
      stage++
      old.stdin.end('/quit\r')
    }
  }

  clearTimeout(timeout)
  assert.equal((await closed)[0], 0, screen.slice(-2000))
  assert.equal(stage, 3)
  const receipts = (
    await readFile(join(project, '.pi/traces/harness/runtime', `${id}.jsonl`), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(receipts.length, 2)
  const [first, recovered] = receipts
  assert.equal(first.piHost.wrapper, wrapper)
  assert.equal(first.source, harnessRoot)
  assert.equal(recovered.piHost.launcherSource, release + '/')
  assert.equal(recovered.pid, first.pid)
  assert.equal(recovered.launcherWarning, undefined)
  assert.ok((await readFile(file, 'utf8')).includes(recovered.loadId))
})
