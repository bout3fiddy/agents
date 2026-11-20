import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { runBranchTask, type BranchAdapters } from '../src/branch-runner.ts'
import { GitHubChecksFailed } from '../src/branch-github.ts'
import { delegationDirectory, type TaskControls } from '../src/delegation-state.ts'
import { atomicJson, readJson } from '../src/state.ts'
import { resolveRemote } from '../src/git-branches.ts'
import { branchRepository, coordinatorEvidence, writeFeature } from './branch-support.ts'

for (const change of ['controls', 'human', 'ci', 'cancel', 'authority', 'none'] as const) {
  test(`final merge gate observes ${change} after a held external review`, async (t) => {
    const setup = await branchRepository(t)
    const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
    const request = requests[0]!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const observedHeads = new Set<string>()
    let afterReview = false
    let finalChecks = 0
    let repairFeedback = ''
    const controller = new AbortController()
    const adapters: Partial<BranchAdapters> = {
      pullRequest: async ({ branch, target }) => ({
        number: 1,
        repository: 'fixture/final-gate',
        branch,
        target,
        url: 'https://github.com/fixture/final-gate/pull/1',
      }),
      checks: async (_pull, head, _signal, options) => {
        assert.equal(options?.registrationGraceMs, observedHeads.has(head) ? 0 : undefined)
        observedHeads.add(head)

        if (afterReview) {
          finalChecks++
          assert.equal(options?.registrationGraceMs, 0)

          if (change === 'human') {
            throw new Error(
              'GitHub review changes requested: human objection arrived while waiting',
            )
          }

          if (change === 'ci') {
            throw new GitHubChecksFailed(
              head,
              [
                {
                  name: 'late-test-rerun',
                  source: 'run',
                  state: 'failed',
                  conclusion: 'failure',
                },
              ],
              'The rerun failed during external review.',
            )
          }
        }

        return {
          status: 'passed',
          head,
          checks: [],
          reviews: [],
          checkedAt: new Date().toISOString(),
        }
      },
      reviews: () => async () => {
        entered()
        await held
        afterReview = true
        return undefined
      },
    }
    const running = runBranchTask(
      setup.store,
      request,
      controller.signal,
      async (assignment) => {
        if (afterReview) {
          repairFeedback = String(JSON.parse(assignment.context).previousFeedback)
          return coordinatorEvidence(assignment, {
            verdict: 'blocked',
            summary: 'The new CI failure requires a retained follow-up.',
          })
        }

        await writeFeature(assignment)
        return coordinatorEvidence(assignment)
      },
      adapters,
    )

    try {
      await Promise.race([
        waiting,
        running.then((state) => {
          throw new Error('Stopped before review: ' + JSON.stringify(state))
        }),
      ])
      assert.equal((await resolveRemote(setup.root)).base, setup.initial)

      if (change === 'controls') {
        await setup.jobs.control(request.id, 'message', 'Add the clarified empty-input rule.')
      } else if (change === 'cancel') {
        await setup.jobs.control(request.id, 'cancel')
      } else if (change === 'authority') {
        const path = join(delegationDirectory(setup.store, request.id), 'controls.json')
        const control = await readJson<TaskControls>(path)
        await atomicJson(path, { ...control, mergeRequested: false })
      }

      release()
      const result = await running
      assert.equal(finalChecks, 1, 'The same head must receive a fresh final CI/human-review check')

      if (change === 'none') {
        assert.equal(result.status, 'complete', result.error)
        assert.equal((await resolveRemote(setup.root)).base, result.commit)
      } else {
        assert.equal(result.status, change === 'cancel' ? 'cancelled' : 'needs_attention')
        assert.equal((await resolveRemote(setup.root)).base, setup.initial)
      }

      if (change === 'controls') {
        assert.match(result.error ?? '', /updates arrived/)
      } else if (change === 'human') {
        assert.match(result.error ?? '', /human objection/)
      } else if (change === 'ci') {
        assert.match(repairFeedback, /late-test-rerun/)
      } else if (change === 'authority') {
        assert.match(result.error ?? '', /authorization changed/)
      }
    } finally {
      release()
      controller.abort()
      await running
    }
  })
}
