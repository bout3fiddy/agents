import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Project, ProjectCheck, WorkerRequest } from '../src/contracts.ts'
import { assignment, createWorkerTools } from '../src/worker-tools.ts'
import { loadRole } from '../src/roles.ts'
import { loadProject, verifyProject } from '../src/project.ts'
import { verifyLoop } from '../src/verification-loop.ts'
import {
  recordTrustDecision,
  taskExecution,
  type ExecutionPolicy,
} from '../src/worker-execution.ts'
import { fixture, hashes } from './support.ts'

const trusted: ExecutionPolicy = { mode: 'trusted-local', reason: 'enrolled' }
const unknown: ExecutionPolicy = { mode: 'isolated', reason: 'unknown-project' }
const pinned = (version: string) =>
  JSON.stringify({
    packages: {
      '': { dependencies: { 'pinned-sdk': version } },
      'node_modules/pinned-sdk': { version },
    },
  })

function setEnvironment(t: TestContext, name: string, value: string | undefined) {
  const previous = process.env[name]
  const assign = (next: string | undefined) => {
    if (next === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = next
    }
  }
  assign(value)
  t.after(() => assign(previous))
}

/** A project whose nested package pins an installed module, beside a different version one level
 * up. The agent directory, and with it the host's trust registry, is private to the test. */
async function nestedProject(t: TestContext) {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  setEnvironment(t, 'PI_HARNESS_AGENT_DIR', join(item.base, 'agent'))
  setEnvironment(t, 'PI_HARNESS_ISOLATION', undefined)
  const files = {
    'pkg/package-lock.json': pinned('1.2.3'),
    'pkg/probe.cjs': "console.log(require('pinned-sdk/package.json').version)\n",
    'pkg/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
    'node_modules/pinned-sdk/package.json': '{"version":"9.9.9"}',
  }

  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(item.root, name)), { recursive: true })
    await writeFile(join(item.root, name), content)
  }

  const request = async (project: Project): Promise<WorkerRequest> => ({
    role: 'implementer',
    model: 'fixture',
    task: 'Run commands',
    workspace: item.root,
    project,
    checkpoint: item.checkpoint,
    outputPath: join(item.base, 'attempt'),
    baseline: {},
  })
  return { ...item, request }
}

/** Invoke a real worker tool as either backend does and return its parsed result. */
async function call(request: WorkerRequest, name: string, input: object) {
  const role = await loadRole('implementer')
  const tool = createWorkerTools(request, role).tools.find((item) => item.name === name)!
  const result = await tool.execute('test', input, undefined, undefined, {} as never)
  const content = result.content[0]!
  assert.equal(content.type, 'text')
  return {
    ...JSON.parse(content.text),
    isError: (result as { isError?: boolean }).isError === true,
    description: tool.description,
  }
}

const writes = (path: string) => [
  'node',
  '-e',
  `require('fs').writeFileSync(${JSON.stringify(path)}, 'escaped')`,
]

test('implementer replays the first divergent seed on frozen copies', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const original = join(item.base, 'original')
  await mkdir(original)
  const installed = join(item.base, 'installed')
  await mkdir(join(installed, 'fixture-dep'), { recursive: true })
  await writeFile(join(installed, 'fixture-dep/index.js'), 'exports.value = 1')
  await symlink(installed, join(item.root, 'node_modules'))
  const reference =
    "require('fs').writeFileSync('dirty', String(require('fixture-dep').value)); " +
    'console.log(process.argv[2])'
  const candidate = reference.replace(
    'log(process.argv[2])',
    'log(+process.argv[2] === 4 ? 0 : process.argv[2])',
  )
  await writeFile(join(original, 'oracle.cjs'), reference)
  await writeFile(join(item.root, 'oracle.cjs'), candidate)
  const request: WorkerRequest = {
    role: 'implementer',
    model: 'fixture',
    task: 'Compare candidates',
    workspace: item.root,
    originals: original,
    project: await loadProject(item.root),
    checkpoint: item.checkpoint,
    outputPath: join(item.base, 'attempt'),
    baseline: {},
  }
  const role = await loadRole('implementer')
  const tool = createWorkerTools(request, role).tools.find(
    (itemTool) => itemTool.name === 'verify_loop',
  )!
  const invoke = async (input: object) => {
    const result = await tool.execute('test', input, undefined, undefined, {} as never)
    const content = result.content[0]!
    assert.equal(content.type, 'text')
    return JSON.parse(content.text)
  }
  const input = {
    mode: 'differential',
    argv: ['node', 'oracle.cjs', '{seed}'],
    firstSeed: 2,
    count: 5,
  }
  const failed = await invoke(input)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.completed, 2)
  assert.equal(failed.seed, 4)
  assert.notEqual(failed.originalSnapshot, failed.snapshot)
  assert.equal((await invoke(failed.replay)).candidateDigest, failed.candidateDigest)
  await Promise.all(
    [item.root, original].map((dir) => assert.rejects(readFile(join(dir, 'dirty')))),
  )

  const common = { mode: 'benchmark', metric: 'bytes', argv: input.argv, firstSeed: 4, count: 2 }
  const bench = await invoke(common)
  assert.deepEqual(bench.comparison, { metric: 'bytes', originalMedian: 4.5, candidateMedian: 2.5 })
  const receipt = JSON.parse(await readFile(join(item.base, bench.receipt), 'utf8'))
  assert.deepEqual(receipt.samples, [
    { seed: 4, original: 4, candidate: 0 },
    { seed: 5, original: 5, candidate: 5 },
  ])

  await writeFile(join(item.root, 'oracle.cjs'), reference)
  const repaired = await invoke(failed.replay)
  assert.equal(repaired.status, 'passed')
  assert.notEqual(repaired.snapshot, failed.snapshot)
  const missingCommand = await invoke({ ...input, argv: ['pi-missing-command-fixture', '{seed}'] })
  assert.equal(missingCommand.status, 'blocked')

  const unavailable = await verifyLoop({ ...request, originals: undefined }, common)
  assert.equal(unavailable.status, 'blocked')
  const skipped = await invoke({ ...input, mode: 'seeded', argv: ['echo', '# SKIP {seed}'] })
  assert.equal(skipped.status, 'skipped')
  const timeout = await invoke({ ...input, argv: ['sh', '-c', 'sleep 2', '{seed}'], timeoutMs: 10 })
  assert.equal(timeout.status, 'blocked')
  const truncated = await invoke({
    ...input,
    argv: ['node', '-e', "console.log('x'.repeat(65000))", '{seed}'],
  })
  assert.equal(truncated.status, 'blocked')
  await assert.rejects(invoke({ ...input, count: 129 }), /Invalid verification/)
})

test('an enrolled project runs worker commands locally with its pinned module', async (t) => {
  const item = await nestedProject(t)
  assert.deepEqual((await loadProject(item.root)).execution, unknown)
  await recordTrustDecision(item.root, 'trusted-local')
  const project = await loadProject(item.root)
  assert.deepEqual(project.execution, trusted)
  const request = await item.request(project)
  const before = await hashes(item.root)

  const run = await call(request, 'run_command', { argv: ['node', 'pkg/probe.cjs'] })
  assert.equal(run.exitCode, 0, run.output)
  assert.equal(run.output.trim(), '1.2.3')
  assert.equal(run.execution, 'trusted-local')
  assert.equal(run.runner, 'host')
  assert.match(run.description, /normal local command in a disposable copy/)
  const assigned = await assignment(request)
  assert.deepEqual(assigned.execution, trusted)
  assert.match(assigned.capabilities.shell, /Normal local commands in disposable project copies/)

  const loop = await call(request, 'verify_loop', {
    mode: 'seeded',
    argv: ['node', 'pkg/probe.cjs', '{seed}'],
    firstSeed: 1,
    count: 2,
  })
  assert.equal(loop.status, 'passed', JSON.stringify(loop))
  assert.equal(loop.execution, 'trusted-local')

  // Writes made in the working directory land in the disposable copy.
  const relative =
    "const fs = require('fs'); fs.writeFileSync('src/value.js', 'changed'); " +
    "fs.writeFileSync('stray.txt', 'stray'); fs.rmSync('pkg/probe.cjs')"
  const copied = await call(request, 'run_command', { argv: ['node', '-e', relative] })
  assert.equal(copied.exitCode, 0, copied.output)
  assert.equal(copied.isError, false)
  assert.deepEqual(await hashes(item.root), before)

  // A local command can name the candidate itself. What it changes outside the assignment is
  // undone and reported; the assigned path is left to the scoped tools and host verification.
  const direct =
    `const fs = require('fs'); const root = ${JSON.stringify(item.root)}; ` +
    "fs.writeFileSync(root + '/stray.txt', 'stray'); " +
    "fs.writeFileSync(root + '/.pi/harness.json', '{}'); " +
    "fs.rmSync(root + '/pkg/probe.cjs'); " +
    "fs.writeFileSync(root + '/src/value.js', 'assigned')"

  for (const [name, input] of [
    ['run_command', { argv: ['node', '-e', direct] }],
    [
      'verify_loop',
      { mode: 'seeded', argv: ['node', '-e', direct, '{seed}'], firstSeed: 0, count: 1 },
    ],
  ] as const) {
    const escaped = await call(request, name, input)
    assert.equal(escaped.isError, true, name)
    assert.deepEqual(
      escaped.restoredCandidatePaths,
      ['.pi/harness.json', 'pkg/probe.cjs', 'stray.txt'],
      name,
    )
    const after = await hashes(item.root)
    assert.notEqual(after['src/value.js'], before['src/value.js'], name)
    assert.deepEqual({ ...after, 'src/value.js': before['src/value.js'] }, before, name)
    await writeFile(join(item.root, 'src', 'value.js'), 'export const value = 0\n')
  }

  // A candidate lockfile the installed tree does not match stops the command.
  await writeFile(join(item.root, 'pkg', 'package-lock.json'), pinned('2.0.0'))
  await assert.rejects(
    call(request, 'run_command', { argv: ['node', 'pkg/probe.cjs'] }),
    /pinned-sdk is 1\.2\.3; the lockfile pins 2\.0\.0.*npm ci/,
  )
  const drifted = await call(request, 'verify_loop', {
    mode: 'seeded',
    argv: ['node', 'pkg/probe.cjs', '{seed}'],
    firstSeed: 1,
    count: 1,
  })
  assert.equal(drifted.status, 'blocked')
  assert.match(drifted.reason, /the lockfile pins 2\.0\.0/)
})

test('an enrolled project reaches loopback until the host revokes its trust', async (t) => {
  const item = await nestedProject(t)
  await recordTrustDecision(item.root, 'trusted-local')
  const request = await item.request(await loadProject(item.root))
  const exchange =
    "const net = require('net'); " +
    "const server = net.createServer((socket) => socket.end('pong')); " +
    "server.listen(0, '127.0.0.1', () => net.connect(server.address().port, '127.0.0.1')" +
    ".on('data', (data) => { console.log(String(data)); server.close() }))"
  const argv = ['node', '-e', exchange]
  const local = await call(request, 'run_command', { argv })
  assert.equal(local.exitCode, 0, local.output)
  assert.equal(local.output.trim(), 'pong')
  assert.equal(local.runner, 'host')

  // The request still carries the decision frozen at dispatch; the next command obeys the host.
  await recordTrustDecision(item.root, 'unknown')
  const revoked = await call(request, 'run_command', { argv })
  assert.equal(revoked.execution, 'isolated')
  assert.equal(revoked.runner, 'sandbox')
  assert.notEqual(revoked.exitCode, 0)
})

test('no request, argument or project file lifts isolation from a worker command', async (t) => {
  const item = await nestedProject(t)
  const canary = join(item.base, 'host-canary')
  const loaded = await loadProject(item.root)
  assert.deepEqual(loaded.execution, unknown)
  const honest = await item.request(loaded)
  const forged = await item.request({ ...loaded, execution: trusted })
  const attempts = [
    { request: honest, input: { argv: writes(canary) } },
    { request: forged, input: { argv: writes(canary) } },
    {
      request: forged,
      input: {
        argv: writes(canary),
        execution: 'trusted-local',
        runner: 'host',
        isolation: 'none',
      },
    },
    {
      request: forged,
      input: {
        argv: ['env', 'PI_HARNESS_ISOLATION=', `PI_HARNESS_AGENT_DIR=${item.root}`].concat(
          writes(canary),
        ),
      },
    },
  ]

  for (const attempt of attempts) {
    const run = await call(attempt.request, 'run_command', attempt.input)
    const label = JSON.stringify(attempt.input)
    assert.equal(run.execution, 'isolated', label)
    assert.equal(run.runner, 'sandbox', label)
    assert.notEqual(run.exitCode, 0, label)
    await assert.rejects(readFile(canary), /ENOENT/, label)
  }

  assert.match((await call(honest, 'run_command', { argv: ['true'] })).description, /isolated argv/)
  assert.deepEqual((await assignment(honest)).execution, unknown)
  const loop = await call(forged, 'verify_loop', {
    mode: 'seeded',
    argv: [...writes(canary), '{seed}'],
    firstSeed: 0,
    count: 1,
  })
  assert.notEqual(loop.status, 'passed')
  assert.equal(loop.execution, 'isolated')
  await assert.rejects(readFile(canary), /ENOENT/)

  // The host's own requirement outranks enrollment, including a decision frozen before it.
  await recordTrustDecision(item.root, 'trusted-local')
  const enrolled = await item.request(await loadProject(item.root))
  setEnvironment(t, 'PI_HARNESS_ISOLATION', 'required')
  const required = await loadProject(item.root)
  assert.deepEqual(required.execution, { mode: 'required-isolation', reason: 'host-policy' })

  for (const request of [enrolled, await item.request(required)]) {
    const run = await call(request, 'run_command', { argv: writes(canary) })
    assert.equal(run.execution, 'required-isolation')
    assert.equal(run.runner, 'sandbox')
    assert.notEqual(run.exitCode, 0)
    await assert.rejects(readFile(canary), /ENOENT/)
  }

  // Control: the same argv writes the canary once nothing but the enrollment applies.
  setEnvironment(t, 'PI_HARNESS_ISOLATION', undefined)
  const control = await call(enrolled, 'run_command', { argv: writes(canary) })
  assert.equal(control.exitCode, 0, control.output)
  assert.equal(await readFile(canary, 'utf8'), 'escaped')

  // The project adapter is a repository file and has no execution field to set.
  const adapter = join(item.root, '.pi', 'harness.json')
  await writeFile(adapter, JSON.stringify({ checks: [], execution: trusted }))
  await assert.rejects(loadProject(item.root), /Unknown project adapter field/)
})

test('an unenrolled project resolves its nested pinned module inside the sandbox', async (t) => {
  const item = await nestedProject(t)
  const request = await item.request(await loadProject(item.root))
  const run = await call(request, 'run_command', { argv: ['node', 'pkg/probe.cjs'] })
  assert.equal(run.execution, 'isolated')
  assert.equal(run.runner, 'sandbox')
  assert.equal(run.exitCode, 0, run.output)
  assert.equal(run.output.trim(), '1.2.3')
})

test('isolated code cannot change the dependency tree it is linked to', async (t) => {
  const item = await nestedProject(t)
  const request = await item.request(await loadProject(item.root))
  const installed = join(item.root, 'pkg', 'node_modules', 'pinned-sdk', 'package.json')
  const overwrite =
    "const fs = require('fs'); " +
    'fs.writeFileSync(\'pkg/node_modules/pinned-sdk/package.json\', \'{"version":"6.6.6"}\'); ' +
    "fs.writeFileSync('pkg/node_modules/planted.js', 'planted')"
  const run = await call(request, 'run_command', { argv: ['node', '-e', overwrite] })
  assert.equal(run.runner, 'sandbox')
  assert.notEqual(run.exitCode, 0)
  assert.equal(await readFile(installed, 'utf8'), '{"version":"1.2.3"}')
  await assert.rejects(readFile(join(item.root, 'pkg', 'node_modules', 'planted.js')), /ENOENT/)
})

test('an enrolled project verifies its checks as local commands', async (t) => {
  const item = await nestedProject(t)
  await recordTrustDecision(item.root, 'trusted-local')
  const nested: ProjectCheck = {
    id: 'nested',
    argv: ['node', 'pkg/probe.cjs'],
    required: true,
    kind: 'test',
    timeoutMs: 30_000,
  }
  const project = { ...(await loadProject(item.root)), checks: [nested] }
  const before = await hashes(item.root)
  const receipt = (await verifyProject(item.root, project, false)).find(
    (candidate) => candidate.check === 'nested',
  )!
  assert.equal(receipt.status, 'passed', receipt.result.output)
  assert.equal(receipt.result.runner, 'host')
  assert.equal(receipt.result.output.trim(), '1.2.3')
  assert.deepEqual(await hashes(item.root), before)
})

test('required isolation reports a host-runner check unavailable, never run', async (t) => {
  const item = await nestedProject(t)
  const canary = join(item.base, 'check-canary')
  const host: ProjectCheck = {
    id: 'host-canary',
    argv: writes(canary),
    required: true,
    kind: 'test',
    timeoutMs: 30_000,
    runner: 'host',
  }
  await rm(join(item.root, 'pkg'), { recursive: true })
  await recordTrustDecision(item.root, 'trusted-local')
  const loaded = { ...(await loadProject(item.root)), checks: [host] }
  const required = {
    ...loaded,
    execution: taskExecution(loaded.execution, { isolation: 'required' }),
  }
  const refused = (await verifyProject(item.root, required, false)).find(
    (candidate) => candidate.check === 'host-canary',
  )!
  assert.equal(refused.status, 'unavailable')
  assert.equal(refused.result.exitCode, null)
  assert.match(refused.result.output, /requires isolation \(task-policy\)\. It was not run/)
  await assert.rejects(readFile(canary), /ENOENT/)

  // Control: without the task's requirement the same check runs on the host.
  const allowed = (await verifyProject(item.root, loaded, false)).find(
    (candidate) => candidate.check === 'host-canary',
  )!
  assert.equal(allowed.status, 'passed', allowed.result.output)
  assert.equal(await readFile(canary, 'utf8'), 'escaped')
})
