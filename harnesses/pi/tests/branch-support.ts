import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TestContext } from 'node:test'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { FanoutInput } from '../src/branch-contracts.ts'
import type { TaskCoordinatorRequest, TaskCoordinatorEvidence } from '../src/task-coordinator.ts'
import type { WorkerResult, WorkerRole } from '../src/contracts.ts'
import { gitCommand, resolveRemote } from '../src/git-branches.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { loadRole } from '../src/roles.ts'
import { StateStore } from '../src/state.ts'
import { startBranchBatch } from '../src/branch-tools.ts'
import { Delegations, type DelegationRequest } from '../src/delegation-state.ts'

export const completed: WorkerResult = {
  verdict: 'pass',
  summary: 'Implemented and tested the specified arithmetic.',
  findings: [],
  databaseImpact: false,
  evidence: ['Executable arithmetic assertions added.'],
}

export async function branchRepository(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-branch-workflow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project')
  const remote = join(directory, 'remote.git')
  await mkdir(root)
  await gitCommand(directory, ['init', '--bare', remote])
  await gitCommand(root, ['init', '-b', 'main'])
  await gitCommand(root, ['config', 'user.name', 'Pi workflow fixture'])
  await gitCommand(root, ['config', 'user.email', 'pi-workflow@example.invalid'])

  for (const folder of ['.pi', 'docs', 'src', 'tests']) {
    await mkdir(join(root, folder))
  }

  await writeFile(join(root, '.pi/.gitignore'), '/traces/\n')
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(
    join(root, '.pi/harness.json'),
    JSON.stringify(
      {
        checks: [
          {
            id: 'behavior',
            argv: ['node', '--test'],
            kind: 'test',
            required: true,
            timeoutMs: 10000,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(join(root, 'src/one.js'), 'export const base = 1\n')
  await writeFile(join(root, 'src/two.js'), 'export const base = 1\n')
  await writeFile(
    join(root, 'tests/base.test.js'),
    [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { base as one } from '../src/one.js'",
      "import { base as two } from '../src/two.js'",
      '',
      "test('existing exports remain available', () => {",
      '  assert.equal(one, 1)',
      '  assert.equal(two, 1)',
      '})',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(root, 'docs/design.md'),
    [
      '# Arithmetic extensions',
      '',
      'Keep both existing base exports equal to one.',
      '',
      'Add doubled(value) to src/one.js and tripled(value) to src/two.js.',
      'Each function multiplies finite numeric input by its named factor.',
      'Each task adds its own behavior tests. No database or benchmark changes are needed.',
      '',
    ].join('\n'),
  )
  await gitCommand(root, ['add', '.'])
  await gitCommand(root, ['commit', '-m', 'Committed design and executable checks'])
  await gitCommand(root, ['remote', 'add', 'origin', remote])
  await gitCommand(root, ['push', 'origin', 'HEAD:main'])
  const initial = (await resolveRemote(root)).base
  const store = new StateStore(root)
  const input: FanoutInput = {
    designPath: 'docs/design.md',
    mergeToMain: true,
    tasks: ['one', 'two'].map((name, index) => ({
      task: `Implement ${index ? 'tripled' : 'doubled'} in ${name}`,
      writePaths: [`src/${name}.js`, `tests/${name}.test.js`],
      invariants: ['Preserve existing exports and the other task.'],
      acceptance: ['Arithmetic properties and existing behavior tests pass.'],
      database: false,
      performance: false,
    })),
  }
  const ctx = {
    cwd: root,
    model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
    sessionManager: { getSessionId: () => 'branch-test-session', getBranch: () => [] },
  } as unknown as ExtensionContext
  const origin = { session: 'branch-test-session', model: 'openai-codex/gpt-6.1-sol' }
  const launch = async (selected: FanoutInput = input) => {
    const requests: DelegationRequest[] = []
    const batch = await startBranchBatch(ctx, selected, undefined, async (request) => {
      requests.push(request)
    })
    return { batch, requests }
  }
  return {
    directory,
    root,
    remote,
    initial,
    store,
    input,
    ctx,
    origin,
    launch,
    jobs: new Delegations(store),
  }
}

export function feature(request: TaskCoordinatorRequest) {
  const name = request.task.includes('doubled') ? 'one' : 'two'
  return { name, factor: name === 'one' ? 2 : 3, fn: name === 'one' ? 'doubled' : 'tripled' }
}

export async function writeFeature(request: TaskCoordinatorRequest, broken = false) {
  const { name, factor, fn } = feature(request)
  await writeFile(
    join(request.workspace, `src/${name}.js`),
    [
      'export const base = 1',
      '',
      `export function ${fn}(value) {`,
      `  return value * ${broken ? factor + 1 : factor}`,
      '}',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(request.workspace, `tests/${name}.test.js`),
    [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      `import { base, ${fn} } from '../src/${name}.js'`,
      '',
      `test('${fn} obeys multiplication and preserves the base export', () => {`,
      '  assert.equal(base, 1)',
      '',
      '  for (const value of [-10, -1, 0, 1, 2, 17]) {',
      `    assert.equal(${fn}(value), value * ${factor})`,
      `    assert.equal(${fn}(value + 1) - ${fn}(value), ${factor})`,
      '  }',
      '})',
      '',
    ].join('\n'),
  )
}

export async function coordinatorEvidence(
  request: TaskCoordinatorRequest,
  result: Partial<WorkerResult> = {},
  roles: WorkerRole[] = ['implementer'],
): Promise<TaskCoordinatorEvidence> {
  const snapshot = snapshotHash(await inventory(request.workspace))
  const children = await Promise.all(
    roles.map(async (name) => {
      const role = await loadRole(name)
      return {
        role: name,
        snapshot,
        result: { ...completed },
        commands: [],
        turns: 1,
        model: role.backend === 'claude-cli' ? `claude-cli/${role.model}` : role.model,
      }
    }),
  )
  return {
    result: { ...completed, ...result },
    children,
    model: (await loadRole('branch-orchestrator')).model,
    turns: 1,
    controlRevision: 0,
  }
}

export async function readCurrentMain(root: string, path: string) {
  const { base } = await resolveRemote(root)
  return gitCommand(root, ['show', `${base}:${path}`])
}

export async function assertRootUnchanged(root: string, initial: string) {
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), initial)
  assert.equal(await readFile(join(root, 'src/one.js'), 'utf8'), 'export const base = 1\n')
  assert.equal(await readFile(join(root, 'src/two.js'), 'utf8'), 'export const base = 1\n')
}
