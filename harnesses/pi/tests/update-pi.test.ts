import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { install } from '../scripts/install.ts'
import {
  harnessCommands,
  installedVersion,
  updatePi,
  usage,
  type UpdateDeps,
} from '../scripts/update-pi.ts'

// Register the standalone offline npm tests in the harness's tests/*.test.ts lane.
await import('../scripts/tests/update-pi-parity.test.ts')

const core = '@earendil-works/pi-coding-agent'
const tui = '@earendil-works/pi-tui'

function installFixture(root: string, specs: string[]) {
  const dependencies: Record<string, string> = { typebox: '1.3.27' }
  const packages: Record<string, unknown> = { '': { dependencies } }

  for (const spec of [...specs, 'typebox@1.3.27']) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const directory = `node_modules/${name}`
    dependencies[name] = version
    packages[directory] = { version }
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version }))
  }

  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
}

async function harness(t: TestContext, options: { failCheck?: boolean; busy?: string[] }) {
  const root = await mkdtemp(join(tmpdir(), 'pi-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  installFixture(root, [`${core}@1.5.2`, `${tui}@1.5.2`])
  const calls = { installs: [] as string[][], checks: 0, specs: [] as string[] }
  const lines: string[] = []
  const deps: UpdateDeps = {
    root,
    resolveVersion: (name, spec) => {
      assert.equal(name, core)
      calls.specs.push(spec)
      return spec === 'latest' ? '1.6.0' : spec
    },
    install: (specs) => {
      calls.installs.push(specs)
      installFixture(root, specs)
    },
    check: () => {
      calls.checks += 1
      return !options.failCheck
    },
    harnessProcesses: () => options.busy ?? [],
    log: (line) => lines.push(line),
  }
  const run = (argv: string[]) => updatePi(argv, deps)
  return { root, deps, calls, lines, run }
}

test('update installs the latest Pi packages together and keeps them on success', async (t) => {
  const { root, calls, lines, run } = await harness(t, {})

  assert.equal(await run([]), 0)
  assert.deepEqual(calls.specs, ['latest'])
  assert.deepEqual(calls.installs, [[`${core}@1.6.0`, `${tui}@1.6.0`]])
  assert.equal(calls.checks, 1)
  assert.equal(await installedVersion(root, core), '1.6.0')
  assert.equal(await installedVersion(root, tui), '1.6.0')
  const pins = { [core]: '1.6.0', [tui]: '1.6.0', typebox: '1.3.27' }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, pins)
  assert.deepEqual(lock.packages[''].dependencies, pins)

  for (const [name, version] of Object.entries(pins)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version)
  }

  assert.match(lines.at(-1)!, /now runs Pi 1\.6\.0/)
})

test('update restores the previous Pi when harness checks fail', async (t) => {
  const { root, calls, lines, run } = await harness(t, { failCheck: true })

  const snapshot = () =>
    Promise.all(['package.json', 'package-lock.json'].map((file) => readFile(join(root, file))))
  const before = await snapshot()
  const marker = join(root, 'node_modules', 'original-tree')
  await writeFile(marker, 'original')
  assert.equal(await run([]), 1)
  assert.deepEqual(calls.installs, [[`${core}@1.6.0`, `${tui}@1.6.0`]])
  assert.deepEqual(await snapshot(), before)
  assert.equal(await readFile(marker, 'utf8'), 'original')
  assert.equal(await installedVersion(root, core), '1.5.2')
  assert.equal(await installedVersion(root, tui), '1.5.2')
  assert.match(
    lines.join('\n'),
    /checks failed on Pi 1\.6\.0[\s\S]*Restored previous pins and installed tree/,
  )
})

test('update is a no-op when the requested Pi is already installed', async (t) => {
  const { calls, lines, run } = await harness(t, {})

  assert.equal(await run(['1.5.2']), 0)
  assert.deepEqual(calls.specs, ['1.5.2'])
  assert.deepEqual(calls.installs, [])
  assert.equal(calls.checks, 0)
  assert.match(lines.at(-1)!, /already runs Pi 1\.5\.2/)
})

test('update refuses while harness processes run unless forced', async (t) => {
  const busy = ['4242 node /harness/node_modules/tsx/dist/loader.mjs /harness/src/worker.ts']
  const { calls, lines, run } = await harness(t, { busy })

  assert.equal(await run([]), 1)
  assert.deepEqual(calls.installs, [])
  assert.match(lines.join('\n'), /in use by 1 harness process[\s\S]*src\/worker\.ts/)

  assert.equal(await run(['--force']), 0)
  assert.equal(calls.installs.length, 1)
})

test('update rejects unexpected arguments with usage', async (t) => {
  const { calls, lines, run } = await harness(t, {})

  assert.equal(await run(['1.6.0', 'extra']), 2)
  assert.equal(await run(['--extensions']), 2)
  assert.deepEqual(calls.installs, [])
  assert.ok(lines.every((line) => line.includes(usage)))
})

test('harness process detection skips this process, its ancestors and descendants', () => {
  const ps = [
    '  1     0 /sbin/launchd',
    ' 10     1 -zsh',
    ' 20    10 node /h/node_modules/.bin/tsx scripts/update-pi.ts',
    ' 21    20 node --import file:///h/node_modules/tsx/dist/loader.mjs scripts/update-pi.ts',
    ' 22    21 /h/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.12 --ping',
    ' 30     1 node /h/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --extension x',
    ' 31     1 node --import /h/node_modules/tsx/dist/loader.mjs /h/src/worker.ts --worker j',
    ' 33    31 /h/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.12 --ping',
    ' 32     1 node /hother/src/worker.ts',
  ].join('\n')

  assert.deepEqual(
    harnessCommands(ps, '/h/', 21).map((line) => line.split(' ')[0]),
    ['30', '31', '33'],
  )
})

test('installed launcher routes the update subcommand to the harness updater', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-update-launcher-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const { wrapper } = await install(join(base, 'agent'))

  const { stdout } = await promisify(execFile)(wrapper, ['update', '--help'], { cwd: base })
  assert.equal(stdout.trim(), usage)
})
