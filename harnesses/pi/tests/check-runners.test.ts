import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Project, ProjectCheck } from '../src/contracts.ts'
import { dependencyDrift, requireDependencies } from '../src/dependencies.ts'
import { gitCommand } from '../src/git-branches.ts'
import { createWorkspace, loadProject, verifyProject } from '../src/project.ts'
import { sandboxProfile } from '../src/sandbox.ts'

async function project(t: TestContext, checks: ProjectCheck[]): Promise<Project> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-check-runners-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (args: string[]) => gitCommand(root, args)
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['config', 'user.email', 'pi@example.invalid'])
  await git(['config', 'user.name', 'Pi'])
  await writeFile(join(root, 'value.txt'), 'one\n')
  await git(['add', '.'])
  await git(['commit', '--quiet', '-m', 'Seed'])
  return { root, checks, instrumentationPaths: [], databasePaths: [] }
}

const node = (code: string) => ['node', '-e', code]
const listen = "require('net').createServer().listen(0, '127.0.0.1', function () { this.close() })"
const check = (id: string, argv: string[], extra: Partial<ProjectCheck> = {}): ProjectCheck => ({
  id,
  argv,
  required: true,
  kind: 'test',
  timeoutMs: 30_000,
  ...extra,
})

test('the adapter accepts sandbox and host runners only', async (t) => {
  const item = await project(t, [])
  const write = (runner: string) =>
    writeFile(
      join(item.root, '.pi', 'harness.json'),
      JSON.stringify({ checks: [{ ...check('probe', ['true']), runner }] }),
    )
  await mkdir(join(item.root, '.pi'))
  await write('host')
  assert.equal((await loadProject(item.root)).checks[0]?.runner, 'host')
  await write('vm')
  await assert.rejects(loadProject(item.root), /Invalid project check/)
})

test('host checks run outside the sandbox after sandbox checks and lint pass', async (t) => {
  const home = `process.exit(process.env.HOME === ${JSON.stringify(homedir())} ? 0 : 1)`
  const item = await project(t, [
    check('sandboxed-listen', node(listen), { required: false }),
    check('host-listen', node(listen), { runner: 'host' }),
    check('host-home', node(home), { runner: 'host' }),
  ])
  const receipts = await verifyProject(item.root, item, false)
  const status = Object.fromEntries(receipts.map((receipt) => [receipt.check, receipt.status]))
  assert.deepEqual(status, {
    'harness-lint': 'passed',
    'sandboxed-listen': 'failed',
    'host-listen': 'passed',
    'host-home': 'passed',
  })
  assert.equal(receipts[0]?.check, 'harness-lint')
})

test('sandbox failures all report and keep the final gate closed', async (t) => {
  const item = await project(t, [
    check('first', node('process.exit(1)')),
    check('second', node('process.exit(2)')),
    check('host', node('process.exit(0)'), { runner: 'host' }),
  ])
  const receipts = await verifyProject(item.root, item, false)
  assert.deepEqual(
    receipts.map((receipt) => [receipt.check, receipt.result.exitCode]),
    [
      ['first', 1],
      ['second', 2],
    ],
  )
})

test('command copies have a Git index and the checkout HEAD', async (t) => {
  const item = await project(t, [])
  const head = await gitCommand(item.root, ['rev-parse', 'HEAD'])
  item.checks.push(
    check('listed', ['git', 'ls-files', '--error-unmatch', 'value.txt']),
    check('head', ['git', 'rev-parse', '--verify', head + '^{commit}']),
    check('clean', ['git', 'diff', '--quiet', 'HEAD']),
  )
  const receipts = await verifyProject(item.root, item, false)
  assert.ok(
    receipts.every((receipt) => receipt.status === 'passed'),
    JSON.stringify(receipts.map((receipt) => [receipt.check, receipt.result.output])),
  )
})

test('tracked files below an ignored directory are not reported deleted', async (t) => {
  const item = await project(t, [])
  await mkdir(join(item.root, 'policy'))
  await writeFile(join(item.root, 'policy', 'tracked.json'), '{}\n')
  await writeFile(join(item.root, '.gitignore'), 'policy\n')
  await gitCommand(item.root, ['add', '-f', '.gitignore', 'policy/tracked.json'])
  await gitCommand(item.root, [
    'commit',
    '--quiet',
    '-m',
    'Track a file below an ignored directory',
  ])
  item.checks.push(check('unchanged', ['sh', '-c', 'test -z "$(git diff --name-only HEAD)"']))
  const receipts = await verifyProject(item.root, item, false)
  assert.ok(
    receipts.every((receipt) => receipt.status === 'passed'),
    JSON.stringify(receipts.map((receipt) => [receipt.check, receipt.result.output])),
  )
})

test('a plain copy of the project uses the project HEAD', async (t) => {
  const item = await project(t, [])
  const copy = await createWorkspace(item.root)
  t.after(() => rm(copy, { recursive: true, force: true }))
  await writeFile(join(copy, 'value.txt'), 'two\n')
  const head = await gitCommand(item.root, ['rev-parse', 'HEAD'])
  item.checks.push(
    check('head', ['git', 'rev-parse', '--verify', head + '^{commit}']),
    check('changed', ['sh', '-c', 'test "$(git diff --name-only HEAD)" = value.txt']),
  )
  const receipts = await verifyProject(copy, item, false)
  assert.ok(
    receipts.every((receipt) => receipt.status === 'passed'),
    JSON.stringify(receipts.map((receipt) => [receipt.check, receipt.result.output])),
  )
})

test('dependency drift names missing and mismatched direct packages', async (t) => {
  const item = await project(t, [])
  const lock = {
    packages: {
      '': { dependencies: { present: '^1.0.0' }, devDependencies: { absent: '2.0.0', old: '3' } },
      'node_modules/present': { version: '1.0.0' },
      'node_modules/absent': { version: '2.0.0' },
      'node_modules/old': { version: '3.1.0' },
    },
  }
  await writeFile(join(item.root, 'package-lock.json'), JSON.stringify(lock))

  for (const [name, version] of [
    ['present', '1.0.0'],
    ['old', '3.0.0'],
  ]) {
    await mkdir(join(item.root, 'node_modules', name!), { recursive: true })
    await writeFile(
      join(item.root, 'node_modules', name!, 'package.json'),
      `{"version":"${version}"}`,
    )
  }

  assert.deepEqual(await dependencyDrift(item.root), [
    'absent@2.0.0 is missing',
    'old is 3.0.0; the lockfile pins 3.1.0',
  ])
  await assert.rejects(requireDependencies(item.root), /absent@2\.0\.0 is missing.*npm ci/)

  // A pinned commit without a lockfile has nothing to compare.
  const head = await gitCommand(item.root, ['rev-parse', 'HEAD'])
  assert.deepEqual(await dependencyDrift(item.root, head), [])
  await gitCommand(item.root, ['add', 'package-lock.json'])
  await gitCommand(item.root, ['commit', '--quiet', '-m', 'Lock'])
  const locked = await gitCommand(item.root, ['rev-parse', 'HEAD'])
  assert.equal((await dependencyDrift(item.root, locked)).length, 2)
})

test('a linked virtual environment and its interpreter prefix are readable', async (t) => {
  const item = await project(t, [])
  const prefix = await realpath(await mkdtemp(join(tmpdir(), 'pi-python-prefix-')))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  await mkdir(join(prefix, 'bin'))
  await writeFile(join(prefix, 'bin', 'python3.12'), '')
  await mkdir(join(item.root, '.venv', 'bin'), { recursive: true })
  await symlink(join(prefix, 'bin', 'python3.12'), join(item.root, '.venv', 'bin', 'python'))
  const workspace = await createWorkspace(item.root)
  t.after(() => rm(workspace, { recursive: true, force: true }))
  assert.equal(await realpath(join(workspace, '.venv')), await realpath(join(item.root, '.venv')))
  const profile = await sandboxProfile(workspace, workspace)
  assert.ok(profile.includes(`(allow file-read* (subpath ${JSON.stringify(prefix)}))`), profile)
})
