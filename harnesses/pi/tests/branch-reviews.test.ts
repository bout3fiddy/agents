import assert from 'node:assert/strict'
import test from 'node:test'
import { awaitAgentReview, type AgentReviewOptions } from '../src/branch-reviews.ts'
import type { GitHubCommand, GitHubPullRequest } from '../src/branch-github.ts'

const head = 'a'.repeat(40)
const prior = 'b'.repeat(40)
const origin = Date.parse('2026-11-17T12:00:00.000Z')
const pr: GitHubPullRequest = {
  number: 7,
  url: 'https://github.com/example/project/pull/7',
  repository: 'example/project',
  branch: 'pi/task',
  target: 'main',
}
const codex = { id: 1, login: 'chatgpt-codex-connector[bot]', type: 'Bot' }
const claude = { id: 2, login: 'claude[bot]', type: 'Bot' }
const human = { id: 3, login: 'claude-human', type: 'User' }
const dated = (offset = 0) => new Date(origin + offset).toISOString()
const review = (id: number, commit = head, user = codex) => ({
  id,
  user,
  commit_id: commit,
  state: 'COMMENTED',
  body: 'Handle empty input.',
  submitted_at: dated(),
  html_url: `${pr.url}#pullrequestreview-${id}`,
})
const pull = (sha = head) => ({
  number: pr.number,
  state: 'open',
  html_url: pr.url,
  head: { sha, ref: pr.branch, repo: { full_name: pr.repository } },
  base: { ref: pr.target, repo: { full_name: pr.repository } },
})

function fixture(change: (path: string, value: unknown, elapsed: number) => unknown) {
  let elapsed = 0
  let requests = 0
  const run: GitHubCommand = async (args, signal) => {
    signal?.throwIfAborted()
    assert.equal(args[0], 'api')
    assert.equal(args[args.indexOf('--method') + 1], 'GET')
    const path = args.find((arg) => arg.startsWith('repos/'))!
    requests++
    let value: unknown = [[]]

    if (path.endsWith('/pulls/7')) {
      value = pull()
    } else if (path.includes('/actions/workflows')) {
      value = [{ workflows: [] }]
    } else if (path.includes('/check-runs')) {
      value = [{ check_runs: [] }]
    } else if (path.includes('/check-suites')) {
      value = [{ check_suites: [] }]
    } else if (path.includes('/status?')) {
      value = [{ statuses: [] }]
    }

    return JSON.stringify(change(path, value, elapsed))
  }
  const options: AgentReviewOptions = {
    run,
    now: () => origin + elapsed,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted()
      elapsed += ms
    },
    minWaitMs: 120000,
    maxWaitMs: 600000,
    pollMs: 30000,
    settleMs: 0,
  }
  return { options, elapsed: () => elapsed, requests: () => requests }
}

test('no triggered agents returns immediately without posting anything', async () => {
  const item = fixture((_path, value) => value)
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.detected, false)
  assert.equal(result.waitMs, 0)
  assert.deepEqual(result.feedback, [])
  assert.equal(item.requests(), 11)
})

test('current-head reviews retain inline locations and exclude stale feedback', async () => {
  const item = fixture((path, value) => {
    if (path.includes('/pulls/7/reviews')) {
      return [[review(10), review(11, prior)]]
    }

    if (path.includes('/pulls/7/comments')) {
      return [
        [10, 11].map((id) => ({
          id,
          user: codex,
          commit_id: head,
          pull_request_review_id: id,
          body: id === 10 ? 'Bound the allocation.' : 'Obsolete finding.',
          path: 'src/queue.ts',
          line: 7,
          created_at: dated(),
          updated_at: dated(),
          html_url: `${pr.url}#discussion_r${id}`,
        })),
      ]
    }

    return value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(60000), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.pending, false)
  assert.equal(result.feedback.length, 2)
  assert.equal(result.feedback.find((entry) => entry.path)?.line, 7)
  assert.ok(result.feedback.every((entry) => !entry.body.includes('Obsolete')))
})

test('a trigger waits minutes for a late reviewer and consumes fresh comments once', async () => {
  const item = fixture((path, value, elapsed) => {
    if (path.includes('/issues/7/comments')) {
      return [
        [{ id: 1, user: human, body: '@claude review', created_at: dated(), updated_at: dated() }],
      ]
    }

    if (path.includes('/pulls/7/reviews') && elapsed >= 180000) {
      return [[{ ...review(20, head, claude), submitted_at: dated(180000) }]]
    }

    return value
  })
  const first = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.ok(first.waitMs >= 180000 && first.waitMs <= 210000)
  assert.equal(first.timedOut, false)
  assert.deepEqual(first.agents, ['claude'])
  const second = await awaitAgentReview(
    pr,
    head,
    {
      notBefore: dated(),
      round: 2,
      consumedIds: first.feedback.map((entry) => entry.id),
    },
    undefined,
    item.options,
  )
  assert.deepEqual(second.feedback, [])
})

test('human names containing agent names never turn human reviews into automation', async () => {
  const item = fixture((path, value) =>
    path.includes('/pulls/7/reviews')
      ? [[{ ...review(3, head, human), state: 'CHANGES_REQUESTED' }]]
      : value,
  )
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.detected, false)
})

test('unanchored and explicitly old-head replies are never treated as fresh feedback', async () => {
  const item = fixture((path, value) =>
    path.includes('/issues/7/comments')
      ? [
          [
            {
              id: 1,
              user: codex,
              body: 'An unanchored finding.',
              created_at: dated(),
              updated_at: dated(),
            },
            {
              id: 2,
              user: codex,
              body: `Review for commit ${prior}: old issue.`,
              created_at: dated(),
              updated_at: dated(),
            },
          ],
        ]
      : value,
  )
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.detected, true)
  assert.equal(result.pending, true)
  assert.equal(result.timedOut, true)
  assert.deepEqual(result.feedback, [])
  assert.equal(result.waitMs, 300000)
})

test('edited bot comments get a new identity and can supply another review round', async () => {
  let body = `Commit ${head}: handle empty input.`
  const item = fixture((path, value) =>
    path.includes('/issues/7/comments')
      ? [
          [
            {
              id: 1,
              user: codex,
              body,
              created_at: dated(),
              updated_at: dated(),
            },
          ],
        ]
      : value,
  )
  const first = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  body = `Commit ${head}: also handle invalid input.`
  const next = await awaitAgentReview(
    pr,
    head,
    {
      notBefore: dated(),
      round: 2,
      consumedIds: first.feedback.map((entry) => entry.id),
    },
    undefined,
    item.options,
  )
  assert.equal(next.feedback.length, 1)
  assert.notEqual(next.feedback[0]?.id, first.feedback[0]?.id)
})

test('repository history gets one discovery window without consuming review rounds', async () => {
  const item = fixture((path, value) => {
    if (path.includes('/pulls/comments?')) {
      return [[{ id: 1, user: codex }]]
    }

    return path.includes('/actions/workflows')
      ? [{ workflows: [{ id: 2, name: 'Claude Review', state: 'active' }] }]
      : value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.deepEqual(result.agents, [])
  assert.equal(result.detected, false)
  assert.equal(result.pending, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.waitMs, 120000)
  assert.ok(result.sources.some((source) => source.startsWith('active-review-workflow:')))
  assert.ok(result.sources.includes('discovery:no-current-pr-review-trigger'))
})

test('an observed PR reviewer does not wait for another repository-history agent', async () => {
  const item = fixture((path, value) => {
    if (path.includes('/pulls/comments?')) {
      return [[{ id: 1, user: codex }]]
    }

    return path.includes('/pulls/7/reviews') ? [[review(10, head, claude)]] : value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.deepEqual(result.agents, ['claude'])
  assert.equal(result.detected, true)
  assert.equal(result.pending, false)
  assert.equal(result.waitMs, 0)
})

test('a delayed current-PR trigger starts its own review deadline after discovery', async () => {
  const item = fixture((path, value, elapsed) => {
    if (path.includes('/pulls/comments?')) {
      return [[{ id: 1, user: codex }]]
    }

    if (path.includes('/issues/7/comments') && elapsed >= 90000) {
      return [
        [
          {
            id: 2,
            user: human,
            body: '@claude review',
            created_at: dated(90000),
          },
        ],
      ]
    }

    return path.includes('/pulls/7/reviews') && elapsed >= 360000
      ? [[{ ...review(3, head, claude), submitted_at: dated(360000) }]]
      : value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.deepEqual(result.agents, ['claude'])
  assert.equal(result.detected, true)
  assert.equal(result.pending, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.waitMs, 360000)
  assert.equal(result.feedback.length, 1)
})

test('observed review duration adapts the bounded deadline for another pending agent', async () => {
  const item = fixture((path, value) => {
    if (path.includes('/issues/7/comments')) {
      return [[{ id: 1, user: human, body: '@claude review', created_at: dated() }]]
    }

    return path.includes('/check-runs')
      ? [
          {
            check_runs: [
              {
                id: 1,
                name: 'Codex review',
                app: { slug: 'github-actions' },
                head_sha: head,
                status: 'completed',
                conclusion: 'success',
                started_at: dated(-240000),
                completed_at: dated(),
              },
            ],
          },
        ]
      : value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.waitMs, 390000)
  assert.equal(result.timedOut, true)
})

test('current-head check runs correlate fresh action comments and output', async () => {
  const item = fixture((path, value) => {
    if (path.includes('/check-runs')) {
      return [
        {
          check_runs: [
            {
              id: 1,
              name: 'Claude review',
              app: { slug: 'github-actions' },
              head_sha: head,
              status: 'completed',
              conclusion: 'success',
              started_at: dated(-30000),
              completed_at: dated(),
              output: { summary: 'Inspect the integer overflow case.' },
            },
          ],
        },
      ]
    }

    return path.includes('/issues/7/comments')
      ? [
          [
            {
              id: 2,
              user: { login: 'github-actions[bot]', type: 'Bot' },
              body: 'Use checked addition.',
              created_at: dated(),
              updated_at: dated(),
            },
          ],
        ]
      : value
  })
  const result = await awaitAgentReview(
    pr,
    head,
    { notBefore: dated(-60000), round: 1 },
    undefined,
    item.options,
  )
  assert.equal(result.feedback.length, 2)
  assert.equal(result.pending, false)
})

test('stale head and cancellation stop review observation without a merge', async () => {
  const item = fixture((path, value) => (path.endsWith('/pulls/7') ? pull(prior) : value))
  await assert.rejects(
    awaitAgentReview(pr, head, { notBefore: dated(), round: 1 }, undefined, item.options),
    /head changed/,
  )
  const controller = new AbortController()
  controller.abort(new Error('Cancelled'))
  await assert.rejects(
    awaitAgentReview(pr, head, { notBefore: dated(), round: 1 }, controller.signal, item.options),
    /Cancelled/,
  )
})
