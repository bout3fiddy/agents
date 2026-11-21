import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { LocalBatch } from '../src/local-contracts.ts'
import type { DelegationRequest } from '../src/delegation-state.ts'
import { gitCommand } from '../src/git-branches.ts'
import { runLocalCandidate } from '../src/local-candidate.ts'
import { compareLocalCandidates, integrateLocalCandidate } from '../src/local-selection.ts'
import { startLocalBatch } from '../src/local-tools.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { atomicJson } from '../src/state.ts'
import { branchRepository, completed } from './branch-support.ts'

async function batchFixture(t: TestContext, mode: LocalBatch['mode'], exclusive = false) {
  const { root, store, ctx } = await branchRepository(t)
  await gitCommand(root, ['remote', 'remove', 'origin'])
  await gitCommand(root, ['switch', '-c', 'cleanup'])
  const requests: DelegationRequest[] = []
  const workload = {
    argv: ['node', '--test', 'tests/base.test.js'],
    workloadPaths: ['tests/base.test.js'],
  }
  const input: LocalBatch = {
    mode,
    ...(mode === 'competition' && {
      comparison: {
        difficulty: 'Unknown resource tradeoff.',
        criterion: 'Retained bytes per operation.',
      },
    }),
    objective: 'Preserve base exports and add one new public constant.',
    acceptance: workload,
    tasks: [1, 2].map((n) => ({
      task: 'Add a public constant using approach ' + n,
      ...(exclusive &&
        n === 1 && {
          acceptance: {
            argv: [
              'node',
              '--input-type=module',
              '-e',
              [
                "import * as one from './src/one.js'",
                "import * as two from './src/two.js'",
                "if (!('added' in one) || 'added' in two) process.exit(1)",
              ].join('\n'),
            ],
          },
        }),
      writePaths: [n === 1 || mode === 'competition' ? 'src/one.js' : 'src/two.js'],
    })),
  }
  const { batch } = await startLocalBatch(ctx, input, undefined, async (request) => {
    requests.push(request)
  })
  const run = async (index: number) => {
    const request = requests[index]!
    const state = await runLocalCandidate(
      store,
      request,
      new AbortController().signal,
      async (w) => {
        await writeFile(
          join(w.workspace, request.writePaths[0]!),
          ['export const base = 1', 'export const added = ' + index, ''].join('\n'),
        )
        return {
          role: 'implementer',
          model: 'fixture',
          result: completed,
          commands: [],
          turns: 1,
          snapshot: snapshotHash(await inventory(w.workspace)),
        }
      },
    )
    assert.equal(state.status, 'complete', state.error)
    return state
  }
  return { root, store, batch, requests, run }
}

test('a sealed competition admits one winner and recovers an interrupted selection', async (t) => {
  const { root, store, batch, run, requests } = await batchFixture(t, 'competition')
  const first = await run(0)
  const before = await compareLocalCandidates(store, batch)
  assert.deepEqual(
    before.candidates.map((item) => item.eligible),
    [true, false],
  )
  await assert.rejects(integrateLocalCandidate(store, first.id), /still active/)
  await run(1)
  const comparison = await compareLocalCandidates(store, batch)
  assert.equal(comparison.candidates.length, 2)
  assert.ok(comparison.candidates.every((item) => item.eligible && item.acceptance?.output))
  const results = await Promise.allSettled(
    requests.map(({ id }) => integrateLocalCandidate(store, id)),
  )
  const successes = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  assert.equal(successes.length, 1)
  const winner = successes[0]!
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), winner.sourceCommit)
  const loser = requests.find((r) => r.id !== winner.id)!
  await assert.rejects(integrateLocalCandidate(store, loser.id), /already selected/)
  assert.deepEqual(await integrateLocalCandidate(store, winner.id), winner)
  const path = join(store.directory, 'local-batches', batch + '.selection.json')
  await atomicJson(path, { ...winner, status: 'pending' })
  await writeFile(join(root, 'src/two.js'), 'after fast-forward\n')
  assert.deepEqual(await integrateLocalCandidate(store, winner.id), winner)
  assert.equal(await readFile(join(root, 'src/two.js'), 'utf8'), 'after fast-forward\n')
  assert.equal((await compareLocalCandidates(store, batch)).selection?.id, winner.id)
})

test('independent candidates integrate with exact combined snapshot evidence', async (t) => {
  const { root, store, run } = await batchFixture(t, 'independent')
  const one = await run(0)
  const two = await run(1)
  await writeFile(join(root, 'src/one.js'), 'user draft\n')
  await assert.rejects(integrateLocalCandidate(store, one.id), /tracked changes/)
  assert.equal(await readFile(join(root, 'src/one.js'), 'utf8'), 'user draft\n')
  await gitCommand(root, ['restore', 'src/one.js'])
  const first = await integrateLocalCandidate(store, one.id)
  const second = await integrateLocalCandidate(store, two.id)
  assert.equal(second.previousTip, first.integratedCommit)
  assert.notEqual(second.integratedCommit, two.commit)
  const snapshot = snapshotHash(await inventory(root))
  assert.ok(second.checks.some((check) => check.check === 'local-acceptance'))
  assert.ok(
    second.checks.every((check) => check.status === 'passed' && check.snapshot === snapshot),
  )
})

test('wrong target and mismatched workload preserve the checkout', async (t) => {
  const { root, store, batch, requests, run } = await batchFixture(t, 'competition')
  const one = await run(0)
  await run(1)
  await gitCommand(root, ['switch', '-c', 'other'])
  await assert.rejects(integrateLocalCandidate(store, one.id), /original target branch/)
  await gitCommand(root, ['switch', 'cleanup'])
  const conflict = 'export const base = 1\nexport const added = 99\n'
  await writeFile(join(root, 'src/one.js'), conflict)
  await gitCommand(root, ['commit', '-am', 'Concurrent edit to the same export'])
  const tip = await gitCommand(root, ['rev-parse', 'HEAD'])
  await assert.rejects(integrateLocalCandidate(store, one.id), /integration conflict: src\/one.js/)
  assert.equal(await readFile(join(root, 'src/one.js'), 'utf8'), conflict)
  const other = requests[1]!
  await atomicJson(join(store.directory, 'delegations', other.id, 'request.json'), {
    ...other,
    local: { ...other.local, acceptance: { ...other.local!.acceptance, argv: ['true'] } },
  })
  await assert.rejects(compareLocalCandidates(store, batch), /same objective and pinned workload/)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), tip)
})

test('a disjoint change must pass the earlier sibling acceptance', async (t) => {
  const { root, store, batch, run } = await batchFixture(t, 'independent', true)
  const first = await run(0)
  const second = await run(1)
  const accepted = await integrateLocalCandidate(store, first.id)
  await assert.rejects(integrateLocalCandidate(store, second.id), /Required checks failed/)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), accepted.integratedCommit)
  assert.deepEqual(
    (await compareLocalCandidates(store, batch)).candidates.map(
      (candidate) => candidate.integrated,
    ),
    ['integrated', undefined],
  )
})
