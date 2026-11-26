import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { defaultDeps, installedVersion, updatePi } from '../update-pi.ts'

const names = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']
const old = '1.0.0'
const target = '2.0.0'
const files = ['package.json', 'package-lock.json'] as const

function pins(version: string) {
  return Object.fromEntries(names.map((name) => [name, version]))
}

async function writeJson(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

// The local tarballs are already resolved in the fixture lock. npm can regenerate the stale root
// pins and perform a genuine clean install without registry metadata, network or a shared cache.
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'update-parity-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'harnesses/pi')
  const pack = join(base, 'package')
  await mkdir(root, { recursive: true })
  await mkdir(pack)
  const packages: Record<string, unknown> = { '': { dependencies: pins(old) } }

  for (const name of names) {
    const manifest = { name, version: target }
    await writeJson(join(pack, 'package.json'), manifest)
    const archive = join(base, `${name.split('/')[1]}.tgz`)
    execFileSync('tar', ['-czf', archive, '-C', base, 'package'])
    const directory = `node_modules/${name}`
    packages[directory] = { version: target, resolved: `file:${archive}` }
    await mkdir(join(root, directory), { recursive: true })
    await writeJson(join(root, directory, 'package.json'), manifest)
  }

  await writeJson(join(root, files[0]), {
    name: 'parity-fixture',
    private: true,
    dependencies: pins(old),
    scripts: { typecheck: 'node check.cjs', test: 'node check.cjs' },
  })
  await writeJson(join(root, files[1]), { name: 'parity-fixture', lockfileVersion: 3, packages })
  await writeFile(join(root, '.npmrc'), `offline=true\ncache=${join(base, 'cache')}\n`)
  await writeFile(
    join(root, 'check.cjs'),
    [
      "const fs = require('node:fs')",
      "fs.appendFileSync('checks', process.env.npm_lifecycle_event + '\\n')",
      "if (fs.existsSync('fail-test') && process.env.npm_lifecycle_event === 'test') {",
      '  process.exit(1)',
      '}',
    ].join('\n'),
  )
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
      cwd: base,
      encoding: 'utf8',
    })
  git('init', '-q')
  git('add', '--', ...files.map((file) => `harnesses/pi/${file}`))
  git('-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture')
  const head = git('rev-parse', 'HEAD')
  const logs: string[] = []
  const selections: string[] = []
  const run = (path = root) =>
    updatePi(['release'], {
      ...defaultDeps(path),
      resolveVersion: (name, spec) => {
        selections.push(`${name}@${spec}`)
        return target
      },
      harnessProcesses: () => [],
      log: (line) => logs.push(line),
    })
  const snapshot = () => Promise.all(files.map((file) => readFile(join(root, file), 'utf8')))
  return { root, base, git, head, run, selections, logs, snapshot }
}

test('installed-at-target drift repairs both pins, survives ci, then no-ops', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'user-note'), 'unfinished work')
  assert.equal(await f.run(), 0, f.logs.join('\n'))
  const after = await f.snapshot()
  assert.deepEqual(JSON.parse(after[0]!).dependencies, pins(target))
  const lock = JSON.parse(after[1]!)
  assert.deepEqual(lock.packages[''].dependencies, pins(target))
  assert.match(f.logs.join('\n'), /drift/i)
  assert.deepEqual(f.selections, [`${names[0]}@release`])

  for (const name of names) {
    assert.equal(lock.packages[`node_modules/${name}`].version, target)
    assert.equal(await installedVersion(f.root, name), target)
  }

  // A second, independent ci must reproduce the same Pi; no-op must not reinstall or run checks.
  execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: f.root,
  })

  for (const name of names) {
    assert.equal(await installedVersion(f.root, name), target)
  }

  const marker = join(f.root, 'node_modules/keep')
  await writeFile(marker, 'not reinstalled')
  assert.equal(await f.run(), 0, f.logs.join('\n'))
  assert.match(f.logs.at(-1)!, /already runs/)
  assert.deepEqual(await f.snapshot(), after)
  assert.equal(await readFile(marker, 'utf8'), 'not reinstalled')
  assert.equal(await readFile(join(f.root, 'checks'), 'utf8'), 'typecheck\ntest\n')
  assert.equal(await readFile(join(f.root, 'user-note'), 'utf8'), 'unfinished work')
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
  assert.equal(f.git('diff', '--cached', '--name-only'), '')
})

test('failed checks restore the original bytes and actual pre-drift tree', async (t) => {
  const f = await fixture(t)
  const before = await f.snapshot()
  const marker = join(f.root, 'node_modules/keep')

  for (const name of names) {
    await writeJson(join(f.root, 'node_modules', name, 'package.json'), { name, version: old })
  }

  await writeFile(marker, 'original')
  await writeFile(join(f.root, 'fail-test'), '')
  assert.equal(await f.run(), 1, f.logs.join('\n'))
  assert.match(f.logs.join('\n'), /Harness checks failed[\s\S]+Restored/)
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(await readFile(marker, 'utf8'), 'original')

  for (const name of names) {
    assert.equal(await installedVersion(f.root, name), old)
  }

  await rm(join(f.root, 'fail-test'))
  assert.equal(await f.run(), 0, f.logs.join('\n'))
})

test('refuses a linked deployment and preserves existing pin edits', async (t) => {
  const f = await fixture(t)
  const linked = join(f.base, 'deployment')
  f.git('worktree', 'add', '--quiet', '--detach', linked)
  const before = await f.snapshot()
  assert.equal(await f.run(join(linked, 'harnesses/pi')), 1)
  assert.match(f.logs.at(-1)!, /canonical primary checkout/)
  assert.deepEqual(await f.snapshot(), before)
  await writeFile(join(f.root, files[0]), `${before[0]}\n`)
  const edited = await f.snapshot()
  assert.equal(await f.run(), 1)
  assert.match(f.logs.at(-1)!, /manifest and lockfile edits/)
  assert.deepEqual(await f.snapshot(), edited)
})
