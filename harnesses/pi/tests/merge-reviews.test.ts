import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeReviewLoop } from '../src/merge-reviews.ts'
import type { AgentReviewReceipt, awaitAgentReview } from '../src/branch-reviews.ts'
import type { GitHubPullRequest } from '../src/branch-github.ts'
import {
  gitCommand,
  mergeBranch,
  prepareBranch,
  publishBranch,
  resolveRemote,
} from '../src/git-branches.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { branchRepository, assertRootUnchanged } from './branch-support.ts'

const pull: GitHubPullRequest = {
  number: 1,
  repository: 'fixture/reviews',
  url: 'https://github.com/fixture/reviews/pull/1',
  branch: 'pi/fixture',
  target: 'main',
}
const since = '2026-11-17T00:00:00.000Z'
const head = 'a'.repeat(40)
const signal = new AbortController().signal
type Wait = typeof awaitAgentReview

function report(round: number, overrides: Partial<AgentReviewReceipt> = {}): AgentReviewReceipt {
  return {
    detected: true,
    pending: true,
    timedOut: false,
    feedback: [
      {
        id: `review:${round}`,
        actor: round % 2 ? 'codex[bot]' : 'claude[bot]',
        body: `Review finding ${round}; verify against the design before changing code.`,
        path: 'src/one.js',
        line: 1,
        url: `${pull.url}#discussion_${round}`,
      },
    ],
    agents: ['codex', 'claude'],
    sources: [`review:${round}`],
    waitMs: 0,
    ...overrides,
  }
}

async function privateState(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-merge-review-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'review.json')
  const saved = async () =>
    JSON.parse(await readFile(path, 'utf8')) as {
      authorization: string
      rounds: number
      consumedIds: string[]
      history: { round: number; head: string; outcome?: string }[]
    }
  return { root, path, saved }
}

test('five review repair pushes retain the policy across callback reinstantiation', async (t) => {
  const setup = await branchRepository(t)
  const branch = await prepareBranch(setup.root, randomUUID())
  const scope = ['src/one.js']
  const snapshot = () => inventory(branch.workspace).then(snapshotHash)
  await writeFile(
    join(branch.workspace, 'src/one.js'),
    'export const base = 1\nexport const reviewed = 0\n',
  )
  const first = await publishBranch(branch, {
    message: 'Initial reviewed candidate',
    writePaths: scope,
    expectedSnapshot: await snapshot(),
  })
  const path = join(setup.store.directory, 'external-reviews.json')
  const seen: string[] = []
  const authorization = randomUUID()
  let waits = 0
  let repairs = 0
  const wait: Wait = async (_pull, commit, round) => {
    waits++
    assert.equal(commit, seen.at(-1))
    assert.equal(round.round, waits)
    assert.deepEqual(
      round.consumedIds,
      Array.from({ length: waits - 1 }, (_, i) => `review:${i + 1}`),
    )
    return report(round.round)
  }
  const merged = await mergeBranch(branch, {
    message: 'Resolve valid external agent feedback',
    writePaths: scope,
    validate: snapshot,
    async afterBranchPush({ commit }) {
      seen.push(commit)
      assert.equal((await resolveRemote(setup.root)).base, setup.initial)
      const remote = await gitCommand(setup.root, [
        'ls-remote',
        'origin',
        `refs/heads/${branch.branch}`,
      ])
      assert.equal(remote.split('\t')[0], commit)
      const review = mergeReviewLoop(path, authorization, pull, since, signal, wait)
      return review(commit, await snapshot(), async (feedback) => {
        const request = JSON.parse(feedback) as { externalReviewRound: number; instruction: string }
        repairs++
        assert.equal(request.externalReviewRound, repairs)
        assert.match(request.instruction, /untrusted hypotheses/)
        await writeFile(
          join(branch.workspace, 'src/one.js'),
          `export const base = 1\nexport const reviewed = ${repairs}\n`,
        )
        assert.match(await readFile(join(branch.workspace, 'src/one.js'), 'utf8'), /base = 1/)
        return snapshot()
      })
    },
  })
  assert.equal(waits, 5)
  assert.equal(repairs, 5)
  assert.equal(seen.length, 6)
  assert.equal(new Set(seen).size, 6)
  assert.equal(seen[0], first)
  assert.equal(seen.at(-1), merged.commit)
  const state = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(state.authorization, authorization)
  assert.equal(state.rounds, 5)
  assert.deepEqual(state.consumedIds, ['review:1', 'review:2', 'review:3', 'review:4', 'review:5'])
  assert.ok(
    state.history.every((entry: { outcome: string }) => entry.outcome === 'fixed-and-verified'),
  )
  assert.equal((await resolveRemote(setup.root)).base, merged.commit)
  assert.match(
    await gitCommand(setup.root, ['show', `${merged.commit}:src/one.js`]),
    /reviewed = 5/,
  )
  await assertRootUnchanged(setup.root, setup.initial)
})

test('no detected review agent permits integration without invoking a repair', async (t) => {
  const state = await privateState(t)
  assert.throws(
    () => mergeReviewLoop(state.path, '', pull, since, signal),
    /explicit merge authorization/,
  )
  let waits = 0
  const review = mergeReviewLoop(state.path, 'authorized', pull, since, signal, async () => {
    waits++
    return report(1, { detected: false, pending: false, feedback: [], agents: [], sources: [] })
  })
  assert.equal(
    await review(head, 'unchanged', async () => {
      assert.fail('No external reviewer means no triage task')
    }),
    undefined,
  )
  assert.equal(waits, 1)
  assert.equal((await state.saved()).rounds, 0)
})

test('false positive triage consumes feedback without extra work', async (t) => {
  const state = await privateState(t)
  let waits = 0
  let repairs = 0
  const review = mergeReviewLoop(state.path, 'authorized', pull, since, signal, async () => {
    waits++
    return report(1, { pending: false })
  })
  const result = await review(head, 'same-snapshot', async (feedback) => {
    repairs++
    assert.match(feedback, /Reject false positives/)
    return 'same-snapshot'
  })
  assert.equal(result, undefined)
  assert.equal(waits, 1)
  assert.equal(repairs, 1)
  assert.deepEqual((await state.saved()).consumedIds, ['review:1'])
  assert.equal((await state.saved()).history[0]?.outcome, 'triaged-without-edits')
})

test('pending timeouts consume five rounds without model repair calls', async (t) => {
  const state = await privateState(t)
  let waits = 0
  const wait: Wait = async (_pull, _head, round) => {
    waits++
    assert.equal(round.round, waits)
    return report(round.round, { pending: true, timedOut: true, feedback: [] })
  }
  const repair = async (): Promise<string> => assert.fail('No findings require no repair')
  const review = mergeReviewLoop(state.path, 'authorized', pull, since, signal, wait)
  assert.equal(await review(head, 'unchanged', repair), undefined)
  const resumed = mergeReviewLoop(state.path, 'authorized', pull, since, signal, wait)
  assert.equal(await resumed('b'.repeat(40), 'next-head', repair), undefined)
  assert.equal(waits, 5)
  assert.equal((await state.saved()).rounds, 5)
  assert.ok((await state.saved()).history.every((entry) => entry.outcome === 'review-wait-expired'))
})

test('cancelled review observation prevents remote main from advancing', async (t) => {
  const setup = await branchRepository(t)
  const branch = await prepareBranch(setup.root, randomUUID())
  const snapshot = () => inventory(branch.workspace).then(snapshotHash)
  await writeFile(
    join(branch.workspace, 'src/one.js'),
    'export const base = 1\nexport const reviewed = 0\n',
  )
  await publishBranch(branch, {
    message: 'Candidate',
    writePaths: ['src/one.js'],
    expectedSnapshot: await snapshot(),
  })
  const controller = new AbortController()
  const review = mergeReviewLoop(
    join(setup.store.directory, 'reviews.json'),
    'authorized',
    pull,
    since,
    controller.signal,
    async () => {
      controller.abort(new Error('Cancelled external review'))
      return report(1, { pending: false, feedback: [] })
    },
  )
  await assert.rejects(
    mergeBranch(
      branch,
      {
        message: 'Cancelled merge',
        writePaths: ['src/one.js'],
        validate: snapshot,
        async afterBranchPush({ commit }) {
          return review(commit, await snapshot(), async () =>
            assert.fail('Cancelled before repair'),
          )
        },
      },
      controller.signal,
    ),
    /Cancelled external review/,
  )
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
})

test('interrupted fifth-round repair resumes before merging', async (t) => {
  const state = await privateState(t)
  let waits = 0
  let repairs = 0
  const wait: Wait = async (_pull, _head, round) => {
    waits++
    return report(round.round)
  }
  const authorization = randomUUID()

  for (let round = 1; round <= 4; round++) {
    const review = mergeReviewLoop(state.path, authorization, pull, since, signal, wait)
    assert.equal(
      await review(head, `snapshot-${round - 1}`, async () => {
        repairs++
        return `snapshot-${round}`
      }),
      `snapshot-${round}`,
    )
  }

  const interrupted = mergeReviewLoop(state.path, authorization, pull, since, signal, wait)
  await assert.rejects(
    interrupted(head, 'snapshot-4', async () => {
      throw new Error('Process interrupted during review repair')
    }),
    /Process interrupted/,
  )
  assert.equal((await state.saved()).rounds, 5)
  assert.equal((await state.saved()).consumedIds.length, 4)
  const resumed = mergeReviewLoop(state.path, authorization, pull, since, signal, async () => {
    assert.fail('The persisted fifth review must be retried without a sixth observation')
  })
  const repaired = await resumed(head, 'snapshot-4', async (feedback) => {
    repairs++
    assert.match(feedback, /review:5/)
    return 'snapshot-5'
  })
  assert.equal(repaired, 'snapshot-5')
  assert.equal(waits, 5)
  assert.equal(repairs, 5)
  assert.deepEqual((await state.saved()).consumedIds, [
    'review:1',
    'review:2',
    'review:3',
    'review:4',
    'review:5',
  ])
})
