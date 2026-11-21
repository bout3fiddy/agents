import { assignment } from '../src/worker-tools.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  delegationDirectory,
  emptyControls,
  type DelegationRequest,
} from '../src/delegation-state.ts'
import type { Dispatcher } from '../src/dispatch.ts'
import { verifyLoop } from '../src/verification-loop.ts'
import { gitCommand } from '../src/git-branches.ts'
import { runLocalCandidate } from '../src/local-candidate.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { atomicJson } from '../src/state.ts'
import { branchRepository, completed } from './branch-support.ts'

async function localFixture(t: TestContext) {
  const setup = await branchRepository(t)
  await gitCommand(setup.root, ['remote', 'remove', 'origin'])
  await gitCommand(setup.root, ['switch', '-c', 'cleanup'])
  const workload = 'acceptance.mjs'
  await writeFile(
    join(setup.root, workload),
    [
      "import assert from 'node:assert/strict'",
      "import { doubled } from './src/one.js'",
      '',
      'assert.equal(doubled(4), 8)',
      '',
    ].join('\n'),
  )
  await writeFile(join(setup.root, '.gitignore'), 'node_modules/\n')
  await gitCommand(setup.root, ['add', '.gitignore'])
  await gitCommand(setup.root, ['add', workload])
  await gitCommand(setup.root, ['commit', '-m', 'Pin local acceptance'])
  const base = await gitCommand(setup.root, ['rev-parse', 'HEAD'])
  await writeFile(join(setup.root, 'src/one.js'), '// Preserve my unfinished edit\n')
  const id = randomUUID()
  const request: DelegationRequest = {
    ...setup.origin,
    root: setup.store.projectRoot,
    id,
    kind: 'branch',
    task: 'Add doubled',
    context: 'Preserve the base export.',
    writePaths: ['src/one.js'],
    createdAt: new Date().toISOString(),
    local: {
      base,
      batch: randomUUID(),
      mode: 'competition',
      targetRef: 'refs/heads/cleanup',
      objective: 'Double an integer',
      workloadPaths: [workload],
      acceptance: {
        id: 'local-acceptance',
        kind: 'test',
        required: true,
        argv: ['node', workload],
        timeoutMs: 5000,
      },
    },
  }
  const directory = delegationDirectory(setup.store, id)
  const control = join(directory, 'controls.json')
  await atomicJson(control, emptyControls)
  await atomicJson(join(directory, 'request.json'), request)
  await atomicJson(join(directory, 'status.json'), {
    id,
    status: 'queued',
    updatedAt: request.createdAt,
  })
  return { ...setup, request, directory, control }
}

async function passingEvidence(workspace: string) {
  return {
    role: 'implementer' as const,
    model: 'fixture',
    turns: 1,
    commands: [],
    snapshot: snapshotHash(await inventory(workspace)),
    result: completed,
  }
}

test('local implementer repairs a failing pinned gate', async (t) => {
  const f = await localFixture(t)
  let calls = 0
  const dispatch: Dispatcher = async (w) => {
    assert.equal(w.role, 'implementer')
    assert.equal(w.checkpoint.objective, f.request.task)
    assert.equal(w.project.checks.at(-1)?.id, 'local-acceptance')
    const dispatched = await assignment({ ...w, outputPath: join(f.directory, 'test-output') })
    assert.deepEqual(dispatched.checkout, {
      pinnedBase: f.request.local!.base,
      head: f.request.local!.base,
      clean: calls === 0,
    })
    calls++

    if (calls === 2) {
      assert.match(w.task, /local-acceptance/)
      assert.match(w.task, /AssertionError/)
    }

    await writeFile(
      join(w.workspace, 'src/one.js'),
      [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        `  return value * ${calls === 1 ? 3 : 2}`,
        '}',
        '',
      ].join('\n'),
    )
    return passingEvidence(w.workspace)
  }
  const state = await runLocalCandidate(f.store, f.request, new AbortController().signal, dispatch)
  assert.equal(state.status, 'complete', state.error)
  assert.equal(calls, 2)
  assert.equal(state.receipts?.find((r) => r.check === 'local-acceptance')?.status, 'passed')
  assert.equal(state.receiptAttempt, state.progressFile)
  assert.equal(await gitCommand(f.root, ['rev-parse', state.branch!]), state.commit)
  assert.equal(await gitCommand(f.root, ['rev-parse', 'HEAD']), f.request.local!.base)
  assert.equal(
    await readFile(join(f.root, 'src/one.js'), 'utf8'),
    '// Preserve my unfinished edit\n',
  )
})

test('resume reconciles a verified local commit after a lost final status write', async (t) => {
  const f = await localFixture(t)
  const run = (dispatch: Dispatcher) =>
    runLocalCandidate(f.store, f.request, new AbortController().signal, dispatch)
  let calls = 0
  const implement: Dispatcher = async (w) => {
    calls++
    await writeFile(
      join(w.workspace, 'src/one.js'),
      [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        '  return value * 2',
        '}',
        '',
      ].join('\n'),
    )
    return passingEvidence(w.workspace)
  }
  const expected = await run(implement)
  assert.equal(expected.status, 'complete', expected.error)
  const requeue = () =>
    atomicJson(join(f.directory, 'status.json'), {
      id: f.request.id,
      status: 'queued',
      updatedAt: new Date().toISOString(),
    })
  await requeue()
  const recovered = await run(implement)
  assert.equal(recovered.status, 'complete', recovered.error)
  assert.equal(recovered.commit, expected.commit)
  assert.deepEqual(recovered.receipts, expected.receipts)
  assert.equal(calls, 1)
  await requeue()
  await atomicJson(f.control, {
    ...emptyControls,
    revision: 1,
    messages: [{ revision: 1, text: 'Recheck the public export' }],
  })
  const fresh = await run(implement)
  assert.equal(fresh.status, 'complete', fresh.error)
  assert.equal(calls, 2)
  assert.notEqual(fresh.progressFile, recovered.progressFile)
})

test('a dependency link ignored by a file-or-directory rule still commits', async (t) => {
  const f = await localFixture(t)
  await writeFile(join(f.root, '.gitignore'), 'node_modules\n')
  await gitCommand(f.root, ['add', '.gitignore'])
  await gitCommand(f.root, ['commit', '-m', 'Ignore dependency links too'])
  f.request.local!.base = await gitCommand(f.root, ['rev-parse', 'HEAD'])
  await mkdir(join(f.root, 'node_modules', 'pi-local-fixture'), { recursive: true })
  const state = await runLocalCandidate(
    f.store,
    f.request,
    new AbortController().signal,
    async (w) => {
      const source = [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        '  return value * 2',
        '}',
        '',
      ].join('\n')
      await writeFile(join(w.workspace, 'src/one.js'), source)
      return passingEvidence(w.workspace)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(await gitCommand(f.root, ['ls-tree', state.commit!, '--', 'node_modules']), '')
})

test('direct worker can compare a local dependency from baseline and candidate', async (t) => {
  const f = await localFixture(t)
  const dependency = join(f.root, 'node_modules', 'pi-local-fixture')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'index.js'), 'module.exports = 10\n')
  let original: string | undefined
  const state = await runLocalCandidate(
    f.store,
    f.request,
    new AbortController().signal,
    async (w) => {
      original = w.originals!
      const loop = await verifyLoop(
        { ...w, outputPath: join(f.directory, 'probe.json') },
        {
          mode: 'differential',
          argv: ['node', '-p', 'require("pi-local-fixture") + {seed}'],
          firstSeed: 1,
          count: 1,
        },
      )
      assert.equal(loop.status, 'passed', JSON.stringify(loop))
      await writeFile(
        join(w.workspace, 'src/one.js'),
        [
          'export const base = 1',
          '',
          'export function doubled(value) {',
          '  return value * 2',
          '}',
          '',
        ].join('\n'),
      )
      return passingEvidence(w.workspace)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(await gitCommand(f.root, ['ls-tree', state.commit!, '--', 'node_modules']), '')
  await assert.rejects(access(original!), { code: 'ENOENT' })
  assert.equal(await readFile(join(dependency, 'index.js'), 'utf8'), 'module.exports = 10\n')
})

test('mixed lint repairs only added findings and completes over inherited ones', async (t) => {
  const f = await localFixture(t)
  const longLine = '// ' + 'x'.repeat(100) + '\n'
  await writeFile(join(f.root, 'zzz.js'), longLine.repeat(140))
  await gitCommand(f.root, ['add', 'zzz.js'])
  await gitCommand(f.root, ['commit', '-m', 'Seed inherited diagnostics'])
  f.request.local!.base = await gitCommand(f.root, ['rev-parse', 'HEAD'])
  let calls = 0
  const state = await runLocalCandidate(
    f.store,
    f.request,
    new AbortController().signal,
    async (w) => {
      calls++

      if (calls === 2) {
        const [{ output }] = JSON.parse(JSON.parse(w.task).feedback)
        assert.match(output, /src\/one\.js:\d+: line exceeds 100 columns/)
        assert.doesNotMatch(output, /zzz\.js/)
      }

      // Lint is the final gate, so the first attempt must pass the behavioral check.
      const source = [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        '  return value * 2',
        '}',
        '',
      ].join('\n')
      await writeFile(join(w.workspace, 'src/one.js'), calls === 1 ? source + longLine : source)
      return passingEvidence(w.workspace)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(calls, 2)
  assert.ok(state.commit)
  const lint = state.receipts?.find((receipt) => receipt.check === 'harness-lint')
  assert.equal(lint?.status, 'passed')
  assert.deepEqual(lint?.inheritedLintPaths, ['zzz.js'])
  assert.match(lint!.result.output, /zzz\.js:140:/)
})

test('a check policy fixed on the checkout reaches a task pinned to the old policy', async (t) => {
  const f = await localFixture(t)
  const policy = join(f.root, '.pi/harness.json')
  const original = await readFile(policy, 'utf8')
  const broken = JSON.parse(original)
  broken.checks[0].argv = ['node', '-e', 'process.exit(3)']
  await writeFile(policy, JSON.stringify(broken, null, 2) + '\n')
  await gitCommand(f.root, ['add', '.pi/harness.json'])
  await gitCommand(f.root, ['commit', '-m', 'Pin a policy the sandbox cannot pass'])
  f.request.local!.base = await gitCommand(f.root, ['rev-parse', 'HEAD'])
  await writeFile(policy, original)
  await gitCommand(f.root, ['add', '.pi/harness.json'])
  await gitCommand(f.root, ['commit', '-m', 'Fix the policy after dispatch'])
  const state = await runLocalCandidate(
    f.store,
    f.request,
    new AbortController().signal,
    async (w) => {
      const source = [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        '  return value * 2',
        '}',
        '',
      ].join('\n')
      await writeFile(join(w.workspace, 'src/one.js'), source)
      return passingEvidence(w.workspace)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(state.receipts?.find((receipt) => receipt.check === 'behavior')?.status, 'passed')
})

test('a task pinned to an unmerged commit uses the checkout policy', async (t) => {
  const f = await localFixture(t)
  const policy = join(f.root, '.pi/harness.json')
  const original = await readFile(policy, 'utf8')
  const broken = JSON.parse(original)
  broken.checks[0].argv = ['node', '-e', 'process.exit(3)']
  await gitCommand(f.root, ['switch', '--quiet', '-c', 'stacked'])
  await writeFile(policy, JSON.stringify(broken, null, 2) + '\n')
  await gitCommand(f.root, ['add', '.pi/harness.json'])
  await gitCommand(f.root, ['commit', '-m', 'Stack work with the old policy'])
  f.request.local!.base = await gitCommand(f.root, ['rev-parse', 'HEAD'])
  await gitCommand(f.root, ['switch', '--quiet', 'cleanup'])
  const state = await runLocalCandidate(
    f.store,
    f.request,
    new AbortController().signal,
    async (w) => {
      const source = [
        'export const base = 1',
        '',
        'export function doubled(value) {',
        '  return value * 2',
        '}',
        '',
      ].join('\n')
      await writeFile(join(w.workspace, 'src/one.js'), source)
      return passingEvidence(w.workspace)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(state.receipts?.find((receipt) => receipt.check === 'behavior')?.status, 'passed')
})

test('local repair returns receipts for a repeated failure', async (t) => {
  const f = await localFixture(t)
  let calls = 0
  const dispatch: Dispatcher = async (w) => {
    calls++
    return passingEvidence(w.workspace)
  }
  const state = await runLocalCandidate(f.store, f.request, new AbortController().signal, dispatch)
  assert.equal(state.status, 'needs_attention')
  assert.match(state.error!, /no progress/)
  assert.equal(calls, 2)
  assert.equal(state.receipts?.at(-1)?.status, 'failed')
  assert.equal(state.commit, undefined)
})

test('a candidate cannot replace its acceptance workload or commit after a pause', async (t) => {
  for (const act of ['workload', 'pause']) {
    const f = await localFixture(t)
    const dispatch: Dispatcher = async (w) => {
      if (act === 'workload') {
        await writeFile(join(w.workspace, 'acceptance.mjs'), 'process.exit(0)\n')
      } else {
        await atomicJson(f.control, { ...emptyControls, paused: true })
      }

      return passingEvidence(w.workspace)
    }
    const state = await runLocalCandidate(
      f.store,
      f.request,
      new AbortController().signal,
      dispatch,
    )
    assert.equal(state.status, act === 'workload' ? 'needs_attention' : 'paused', state.error)
    assert.equal(state.commit, undefined)

    if (act === 'workload') {
      assert.match(state.error!, /Pinned local acceptance workload changed/)
    }
  }
})
