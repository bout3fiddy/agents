import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { startLocalBatch } from '../src/local-tools.ts'
import { compareLocalCandidates } from '../src/local-selection.ts'
import { gitCommand } from '../src/git-branches.ts'
import type { DelegationRequest } from '../src/delegation-state.ts'
import { delegationDirectory } from '../src/delegation-state.ts'
import { reviseTasks } from '../src/task-recovery.ts'
import { atomicJson } from '../src/state.ts'
import type { LocalBatch } from '../src/local-contracts.ts'
import { branchRepository } from './branch-support.ts'

const competition: LocalBatch = {
  mode: 'competition',
  comparison: {
    difficulty: 'Two algorithms have unknown scaling.',
    criterion: 'Lower peak memory at the same correct result.',
  },
  objective: 'Compare two arithmetic implementations.',
  acceptance: { argv: ['node', '--test'], workloadPaths: ['tests/**'] },
  tasks: ['Iterative', 'Recursive'].map((task) => ({ task, writePaths: ['src/one.js'] })),
}

test('competing scopes survive revision and resume', async (t) => {
  const fixture = await branchRepository(t)
  const git = (args: string[]) => gitCommand(fixture.root, args)
  await git(['remote', 'remove', 'origin'])
  await git(['switch', '-c', 'feature'])
  const tasks: DelegationRequest[] = []
  const launch = async (request: DelegationRequest) => {
    tasks.push(request)
  }
  const batch = await startLocalBatch(fixture.ctx, competition, undefined, launch)
  assert.equal(batch.base, await git(['rev-parse', 'HEAD']))
  assert.equal(batch.targetRef, 'refs/heads/feature')
  assert.equal(tasks.length, 2)
  assert.ok(tasks.every((item) => !item.context.includes(competition.comparison!.criterion)))
  assert.ok(tasks.every((item) => item.context.includes('only the assigned approach')))
  assert.deepEqual(
    (await compareLocalCandidates(fixture.store, batch.batch)).candidates.map((c) => c.eligible),
    [false, false],
  )
  await assert.rejects(startLocalBatch(fixture.ctx, competition, undefined, launch), /disjoint/)
  const first = tasks[0]!
  await fixture.jobs.control(first.id, 'pause')
  const directory = delegationDirectory(fixture.store, first.id)
  const state = (await fixture.jobs.get(first.id)).state
  await atomicJson(join(directory, 'status.json'), { ...state, status: 'paused' })
  await reviseTasks(fixture.jobs, {
    tasks: [{ id: first.id, task: 'Use iteration', context: 'Compare on the same workload.' }],
  })
  await fixture.jobs.resume(first.id, fixture.origin, launch)
  assert.deepEqual(tasks.at(-1)?.local, first.local)
  await assert.rejects(
    fixture.jobs.requestMerge([first.id], fixture.origin, launch),
    /integrate_candidate/,
  )
})

test('invalid local scopes, workloads and models fail before launch', async (t) => {
  const fixture = await branchRepository(t)
  const never = async () => {
    assert.fail('Preflight launched a worker')
  }

  const { mode: _mode, comparison: _comparison, ...ordinary } = competition

  for (const [invalid, reason] of [
    [ordinary, /disjoint/],
    [{ ...ordinary, mode: 'competition' }, /tradeoff/],
    [{ ...competition, tasks: [competition.tasks[0]!] }, /shared pinned workload/],
    [
      { ...competition, acceptance: { argv: ['node'], workloadPaths: ['not-in-git'] } },
      /pinned commit/,
    ],
    [{ ...competition, acceptance: { argv: ['node'], workloadPaths: ['src/**'] } }, /outside/],
    [
      {
        ...competition,
        tasks: competition.tasks.map((task) => ({ ...task, acceptance: { argv: ['true'] } })),
      },
      /shared pinned workload/,
    ],
    [
      {
        ...competition,
        tasks: competition.tasks.map((task) => ({
          ...task,
          implementerModel: 'opus',
          thinking: 'low',
        })),
      },
      /medium or high/,
    ],
  ] as const) {
    await assert.rejects(
      startLocalBatch(fixture.ctx, invalid as LocalBatch, undefined, never),
      reason,
    )
  }

  assert.deepEqual(await fixture.jobs.list(), [])
  const { tasks } = await startLocalBatch(
    fixture.ctx,
    {
      objective: 'Add a single new operation.',
      tasks: [competition.tasks[0]!],
      acceptance: competition.acceptance,
    },
    undefined,
    async () => {},
  )
  assert.deepEqual(
    tasks.map((task) => task.mode),
    ['independent'],
  )
})
