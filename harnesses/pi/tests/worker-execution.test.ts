// Standalone: Node built-ins and src/worker-execution.ts only, so the critical execution policy is
// checked by `node --experimental-strip-types --test` inside an isolated candidate copy that has
// no installed dependencies. Routes through the real worker tools are covered by
// verification-loop.test.ts and worker-lifecycle.test.ts.
import assert from 'node:assert/strict'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import {
  checkRunner,
  decideExecution,
  effectiveExecution,
  executionModes,
  isolationUnavailable,
  linkLockedDependencies,
  readTrustRegistry,
  recordTrustDecision,
  resolveExecution,
  runWorkerCommand,
  storedExecution,
  strictest,
  taskExecution,
  trustRegistryPath,
} from '../src/worker-execution.ts'
import type { ExecutionPolicy, TrustRegistry } from '../src/worker-execution.ts'

const trusted: ExecutionPolicy = { mode: 'trusted-local', reason: 'enrolled' }
const unknown: ExecutionPolicy = { mode: 'isolated', reason: 'unknown-project' }
const policies: ExecutionPolicy[] = [
  trusted,
  unknown,
  { mode: 'required-isolation', reason: 'project-policy' },
  { mode: 'required-isolation', reason: 'task-policy' },
  { mode: 'required-isolation', reason: 'host-policy' },
]
const rank = (policy: ExecutionPolicy) => executionModes.indexOf(policy.mode)
const lockfile = (version: string) =>
  JSON.stringify({
    packages: {
      '': { dependencies: { 'pinned-sdk': version } },
      'node_modules/pinned-sdk': { version },
    },
  })

async function workbench(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-execution-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project')
  await mkdir(root)
  const registryPath = join(base, 'agent', 'harness-trust.json')
  return { base, root, sources: { registryPath, environment: {} } }
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }
}

/** A disposable command copy of the authored files, as createWorkspace makes one. */
async function commandCopy(base: string, root: string, names: string[]) {
  const probe = await mkdtemp(join(base, 'copy-'))

  for (const name of names) {
    await mkdir(dirname(join(probe, name)), { recursive: true })
    await cp(join(root, name), join(probe, name))
  }

  return probe
}

test('an unknown project stays isolated and only its exact enrolled root is trusted', async (t) => {
  const { base, root, sources } = await workbench(t)
  assert.deepEqual(await resolveExecution(root, false, sources), unknown)
  assert.deepEqual(await recordTrustDecision(root, 'trusted-local', sources), trusted)
  assert.equal((await stat(sources.registryPath)).mode & 0o777, 0o600)
  assert.deepEqual(Object.keys((await readTrustRegistry(sources.registryPath)).projects), [root])

  // Enrollment names one canonical directory: not its children, copies or missing paths.
  await mkdir(join(root, 'nested'))
  await cp(root, join(base, 'copy'), { recursive: true })
  await symlink(root, join(base, 'alias'))
  assert.deepEqual(await resolveExecution(join(root, 'nested'), false, sources), unknown)
  assert.deepEqual(await resolveExecution(join(base, 'copy'), false, sources), unknown)
  assert.deepEqual(await resolveExecution(join(base, 'absent'), false, sources), unknown)
  assert.deepEqual(await resolveExecution(base, false, sources), unknown)
  assert.deepEqual(await resolveExecution(join(base, 'alias'), false, sources), trusted)

  assert.deepEqual(await recordTrustDecision(root, 'required-isolation', sources), {
    mode: 'required-isolation',
    reason: 'project-policy',
  })
  assert.deepEqual(await recordTrustDecision(root, 'unknown', sources), unknown)
  assert.deepEqual((await readTrustRegistry(sources.registryPath)).projects, {})
  await assert.rejects(recordTrustDecision(root, 'host' as never, sources), /Decision must be/)
  await assert.rejects(recordTrustDecision(join(base, 'absent'), 'trusted-local', sources))
})

test('files inside a project cannot grant it trust', async (t) => {
  const { root, sources } = await workbench(t)
  const claim = JSON.stringify({
    version: 1,
    execution: trusted,
    projects: { [root]: { execution: 'trusted-local', decidedAt: 'now' } },
  })
  await writeFiles(root, {
    'harness-trust.json': claim,
    '.pi/harness-trust.json': claim,
    '.pi/harness.json': claim,
    '.pi/agent/harness-trust.json': claim,
  })
  assert.deepEqual(await resolveExecution(root, false, sources), unknown)
  assert.deepEqual(await effectiveExecution({ root, execution: trusted }, sources), unknown)

  // The default registry is the private agent directory, never a path below the project.
  const path = trustRegistryPath({ PI_HARNESS_AGENT_DIR: '/private/agent' })
  assert.equal(path, '/private/agent/harness-trust.json')
  assert.equal(trustRegistryPath({}), join(homedir(), '.pi', 'agent', 'harness-trust.json'))
})

test('every isolation demand wins over enrollment', () => {
  const root = '/checkout'
  const entries = [undefined, 'trusted-local', 'required-isolation'] as const

  for (const entry of entries) {
    for (const hostIsolation of [false, true]) {
      for (const taskIsolation of [false, true]) {
        const registry: TrustRegistry = {
          version: 1,
          projects: entry ? { [root]: { execution: entry, decidedAt: 'now' } } : {},
        }
        const decided = decideExecution({ root, registry, hostIsolation, taskIsolation })
        const demanded = hostIsolation || taskIsolation || entry === 'required-isolation'
        const expected = demanded
          ? 'required-isolation'
          : entry === 'trusted-local'
            ? 'trusted-local'
            : 'isolated'
        assert.equal(
          decided.mode,
          expected,
          JSON.stringify({ entry, hostIsolation, taskIsolation }),
        )
        assert.deepEqual(storedExecution(decided), decided)
      }
    }
  }

  // An unresolved root is never looked up, even against a registry that names it.
  const registry: TrustRegistry = {
    version: 1,
    projects: { undefined: { execution: 'trusted-local', decidedAt: 'now' } },
  }
  const unresolved = { root: undefined, registry, hostIsolation: false, taskIsolation: false }
  assert.deepEqual(decideExecution(unresolved), unknown)

  for (const first of policies) {
    for (const second of policies) {
      assert.equal(rank(strictest(first, second)), Math.max(rank(first), rank(second)))
    }
  }
})

test('a stored request can add isolation but never remove it', async (t) => {
  const { root, sources } = await workbench(t)
  const required = { ...sources, environment: { PI_HARNESS_ISOLATION: 'required' } }
  const states = [
    { decision: 'unknown', sources },
    { decision: 'trusted-local', sources },
    { decision: 'required-isolation', sources },
    { decision: 'trusted-local', sources: required },
  ] as const

  for (const state of states) {
    await recordTrustDecision(root, state.decision, sources)
    const current = await resolveExecution(root, false, state.sources)

    for (const frozen of [undefined, ...policies]) {
      const effective = await effectiveExecution({ root, execution: frozen }, state.sources)
      const label = JSON.stringify({ decision: state.decision, frozen, effective })
      assert.ok(rank(effective) >= rank(storedExecution(frozen)), label)
      assert.ok(rank(effective) >= rank(current), label)
      assert.equal(
        effective.mode === 'trusted-local',
        frozen === trusted && current.mode === 'trusted-local',
        label,
      )
    }
  }

  // A request that claims trust for a root the host never enrolled runs isolated.
  await recordTrustDecision(root, 'unknown', sources)
  assert.deepEqual(await effectiveExecution({ root, execution: trusted }, sources), unknown)
  assert.equal(
    (await effectiveExecution({ root, execution: trusted }, required)).reason,
    'host-policy',
  )

  for (const forged of [
    null,
    'trusted-local',
    {},
    { mode: 'trusted-local' },
    { reason: 'enrolled' },
  ]) {
    assert.throws(() => storedExecution(forged), /Invalid stored execution policy/)
  }

  assert.throws(
    () => storedExecution({ mode: 'trusted-local', reason: 'host-policy' }),
    /Invalid stored execution policy/,
  )
  assert.throws(() => storedExecution({ mode: 'host', reason: 'enrolled' }), /Invalid stored/)

  // The host task's requirement narrows an enrolled project and accepts no other value.
  assert.deepEqual(taskExecution(trusted, {}), trusted)
  assert.deepEqual(taskExecution(undefined, {}), unknown)
  assert.deepEqual(taskExecution(trusted, { isolation: 'required' }), {
    mode: 'required-isolation',
    reason: 'task-policy',
  })
  assert.equal(taskExecution(policies[2], { isolation: 'required' }).reason, 'project-policy')
  assert.throws(() => taskExecution(trusted, { isolation: 'optional' }), /only "required"/)
  assert.throws(() => taskExecution(trusted, { isolation: false }), /only "required"/)
  const relaxed = { ...sources, environment: { PI_HARNESS_ISOLATION: 'off' } }
  await assert.rejects(resolveExecution(root, false, relaxed), /accepts only "required"/)
})

test('a damaged registry stops resolution instead of defaulting', async (t) => {
  const { base, root, sources } = await workbench(t)
  const path = sources.registryPath
  const entry = { execution: 'trusted-local', decidedAt: 'now' }
  const crowded = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`/project-${index}`, entry]),
  )
  const damaged = [
    '{',
    'null',
    JSON.stringify({ version: 2, projects: {} }),
    JSON.stringify({ version: 1, projects: [] }),
    JSON.stringify({ version: 1, projects: { relative: entry } }),
    JSON.stringify({ version: 1, projects: { [root]: { execution: 'host', decidedAt: 'now' } } }),
    JSON.stringify({ version: 1, projects: { [root]: { execution: 'trusted-local' } } }),
    JSON.stringify({ version: 1, projects: crowded }),
  ]
  await mkdir(dirname(path), { recursive: true })

  for (const text of damaged) {
    await writeFile(path, text)
    await assert.rejects(resolveExecution(root, false, sources), /Trust registry is/, text)
    await assert.rejects(recordTrustDecision(root, 'trusted-local', sources), /Trust registry is/)
  }

  // A registry reached through a link is not the host's own file.
  await rm(path)
  await writeFile(join(base, 'elsewhere.json'), JSON.stringify({ version: 1, projects: {} }))
  await symlink(join(base, 'elsewhere.json'), path)
  await assert.rejects(resolveExecution(root, false, sources), /not a regular file/)

  // The registry is bounded: a full one rejects a new project and still updates a listed one.
  await rm(path)
  const full = Object.fromEntries(Object.entries(crowded).slice(0, 256))
  await writeFile(path, JSON.stringify({ version: 1, projects: full }))
  await assert.rejects(recordTrustDecision(root, 'trusted-local', sources), /at most 256/)
  assert.deepEqual(await resolveExecution(root, false, sources), unknown)
})

test('a trusted command resolves the nested module its lockfile pins', async (t) => {
  const { base, root } = await workbench(t)
  const probeScript =
    "console.log(require('pinned-sdk/package.json').version); " +
    'console.log(process.env.HOME); ' +
    "console.log(process.env.PI_EXECUTION_TEST_TOKEN ?? 'no token')"
  await writeFiles(root, {
    'pkg/package-lock.json': lockfile('1.2.3'),
    'pkg/probe.cjs': probeScript,
    'pkg/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
    'other/package-lock.json': lockfile('4.0.0'),

    // A different version one level up: resolution must never climb to it.
    'node_modules/pinned-sdk/package.json': '{"version":"9.9.9"}',
  })
  const names = ['pkg/package-lock.json', 'pkg/probe.cjs', 'other/package-lock.json']
  const probe = await commandCopy(base, root, names)
  await symlink(join(root, 'node_modules'), join(probe, 'node_modules'))
  const linked = await linkLockedDependencies(probe, root, names, trusted)
  assert.deepEqual(linked, [join(root, 'pkg', 'node_modules')])
  await assert.rejects(lstat(join(probe, 'other', 'node_modules')), /ENOENT/)

  process.env.PI_EXECUTION_TEST_TOKEN = 'credential'
  t.after(() => delete process.env.PI_EXECUTION_TEST_TOKEN)
  const result = await runWorkerCommand(trusted, {
    workspace: join(probe, 'pkg'),
    argv: ['node', 'probe.cjs'],
    timeoutMs: 30_000,
  })
  assert.equal(result.exitCode, 0, result.output)
  assert.equal(result.runner, 'host')

  // The user's own home, and none of the host process's other environment.
  assert.deepEqual(result.output.trim().split('\n'), ['1.2.3', homedir(), 'no token'])

  // The installed tree is the checkout's own, and the command's writes stay in the copy.
  assert.equal(await realpath(join(probe, 'pkg', 'node_modules')), join(root, 'pkg/node_modules'))
  const writer = await runWorkerCommand(trusted, {
    workspace: probe,
    argv: ['node', '-e', "require('fs').writeFileSync('pkg/probe.cjs', 'changed')"],
  })
  assert.equal(writer.exitCode, 0, writer.output)
  assert.equal(await readFile(join(root, 'pkg', 'probe.cjs'), 'utf8'), probeScript)
})

test('a tree that differs from the candidate lockfile fails instead of loading', async (t) => {
  const { base, root } = await workbench(t)
  await writeFiles(root, {
    'pkg/package-lock.json': lockfile('2.0.0'),
    'pkg/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
    'broken/package-lock.json': '{',
    'broken/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
  })

  for (const policy of [trusted, unknown]) {
    const probe = await commandCopy(base, root, ['pkg/package-lock.json'])
    await assert.rejects(
      linkLockedDependencies(probe, root, ['pkg/package-lock.json'], policy),
      /pkg\/package-lock\.json: pinned-sdk is 1\.2\.3; the lockfile pins 2\.0\.0.*npm ci/,
    )
    await assert.rejects(lstat(join(probe, 'pkg', 'node_modules')), /ENOENT/)
  }

  const probe = await commandCopy(base, root, ['broken/package-lock.json'])
  await assert.rejects(
    linkLockedDependencies(probe, root, ['broken/package-lock.json'], trusted),
    /not valid JSON/,
  )

  // No nested lockfile, or no checkout to link from, leaves the copy as it was.
  assert.deepEqual(await linkLockedDependencies(probe, root, ['package-lock.json'], trusted), [])
  const absent = join(base, 'absent')
  assert.deepEqual(
    await linkLockedDependencies(probe, absent, ['pkg/package-lock.json'], trusted),
    [],
  )
  await assert.rejects(
    linkLockedDependencies(probe, root, ['../package-lock.json'], trusted),
    /leaves the snapshot/,
  )
})

test('isolation never exposes a dependency tree outside the project', async (t) => {
  const { base, root } = await workbench(t)
  const outside = join(base, 'outside')
  await writeFiles(outside, { 'pinned-sdk/package.json': '{"version":"1.2.3"}' })
  await writeFiles(root, { 'pkg/package-lock.json': lockfile('1.2.3') })
  await symlink(outside, join(root, 'pkg', 'node_modules'))
  const names = ['pkg/package-lock.json']

  for (const policy of policies.filter((item) => item.mode !== 'trusted-local')) {
    const probe = await commandCopy(base, root, names)
    await assert.rejects(linkLockedDependencies(probe, root, names, policy), /outside the project/)
    await assert.rejects(lstat(join(probe, 'pkg', 'node_modules')), /ENOENT/)
  }

  // The user's trusted checkout may keep its dependencies wherever it links them.
  const probe = await commandCopy(base, root, names)
  assert.deepEqual(await linkLockedDependencies(probe, root, names, trusted), [outside])
})

test('a command copy links a bounded number of nested dependency trees', async (t) => {
  const { base, root } = await workbench(t)
  const packages = Array.from({ length: 65 }, (_, index) => `package-${index}`)

  for (const name of packages) {
    await writeFiles(root, {
      [`${name}/package-lock.json`]: lockfile('1.2.3'),
      [`${name}/node_modules/pinned-sdk/package.json`]: '{"version":"1.2.3"}',
    })
  }

  const names = packages.map((name) => `${name}/package-lock.json`)
  const within = await commandCopy(base, root, names.slice(0, 64))
  assert.equal((await linkLockedDependencies(within, root, names.slice(0, 64), trusted)).length, 64)
  const beyond = await commandCopy(base, root, names)
  await assert.rejects(linkLockedDependencies(beyond, root, names, trusted), /More than 64 nested/)
})

test('an isolated command never writes a host canary, with or without a sandbox', async (t) => {
  const { base, root, sources } = await workbench(t)
  await writeFiles(root, { 'value.txt': 'one\n' })
  const canary = join(base, 'host-canary')
  const argv = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(canary)}, 'escaped')`]

  // The last case is a worker request that claims trust the host never granted.
  const forged = await effectiveExecution({ root, execution: trusted }, sources)
  const isolated = [...policies.filter((item) => item.mode !== 'trusted-local'), forged]

  for (const policy of isolated) {
    const probe = await commandCopy(base, root, ['value.txt'])
    const outcome = await runWorkerCommand(policy, { workspace: probe, argv }).catch(
      (error: unknown) => error,
    )

    // A working sandbox denies the write. One that cannot start (another platform, or nested
    // inside a sandbox as in candidate acceptance) fails the command. Neither runs it on the host.
    if (!(outcome instanceof Error)) {
      const result = outcome as Awaited<ReturnType<typeof runWorkerCommand>>
      assert.equal(result.runner, 'sandbox')
      assert.notEqual(result.exitCode, 0, result.output)
    }

    await assert.rejects(readFile(canary), /ENOENT/, JSON.stringify(policy))
  }

  // Control: the same argv does write the canary once the host has enrolled the project.
  await recordTrustDecision(root, 'trusted-local', sources)
  const enrolled = await effectiveExecution({ root, execution: trusted }, sources)
  const probe = await commandCopy(base, root, ['value.txt'])
  const result = await runWorkerCommand(enrolled, { workspace: probe, argv })
  assert.equal(result.exitCode, 0, result.output)
  assert.equal(await readFile(canary, 'utf8'), 'escaped')

  const blocked = { exitCode: 71, output: 'sandbox-exec: sandbox_apply: Operation not permitted' }
  const base71 = { argv, timedOut: false, aborted: false, truncated: false, durationMs: 1 }
  assert.equal(isolationUnavailable({ ...base71, ...blocked }), true)
  assert.equal(isolationUnavailable({ ...base71, ...blocked, exitCode: 1 }), false)
  const missing = 'sandbox-exec: execvp() of absent failed: No such file or directory'
  assert.equal(isolationUnavailable({ ...base71, exitCode: 71, output: missing }), false)
})

test('required isolation refuses a host runner that a project file declares', () => {
  const table = policies.map((policy) => [
    policy.reason,
    checkRunner(policy, undefined),
    checkRunner(policy, 'sandbox'),
    checkRunner(policy, 'host'),
  ])
  assert.deepEqual(table, [
    ['enrolled', 'host', 'host', 'host'],
    ['unknown-project', 'sandbox', 'sandbox', 'host'],
    ['project-policy', 'sandbox', 'sandbox', 'refused'],
    ['task-policy', 'sandbox', 'sandbox', 'refused'],
    ['host-policy', 'sandbox', 'sandbox', 'refused'],
  ])
})

test('commands are bounded and reject a mismatched decision in every mode', async (t) => {
  const { base, root } = await workbench(t)
  await writeFiles(root, { 'value.txt': 'one\n' })
  const workspace = await commandCopy(base, root, ['value.txt'])
  const argv = ['node', '-e', '0']

  for (const policy of policies) {
    await assert.rejects(runWorkerCommand(policy, { workspace, argv: [] }), /Invalid command/)
    await assert.rejects(runWorkerCommand(policy, { workspace, argv, timeoutMs: 0 }), /timeout/)
    await assert.rejects(
      runWorkerCommand(policy, { workspace, argv, timeoutMs: 900_001 }),
      /between 1 ms and 15 minutes/,
    )
    const cancelled = AbortSignal.abort(new Error('stopped before start'))
    await assert.rejects(
      runWorkerCommand(policy, { workspace, argv, signal: cancelled }),
      /stopped before start/,
    )
  }

  const mismatched = { mode: 'trusted-local', reason: 'host-policy' } as ExecutionPolicy
  await assert.rejects(
    runWorkerCommand(mismatched, { workspace, argv }),
    /mode and reason disagree/,
  )
})
