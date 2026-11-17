import assert from 'node:assert/strict'
import test from 'node:test'
import {
  awaitBranchChecks,
  ensureBranchPullRequest,
  githubRepository,
  GitHubChecksFailed,
  type GitHubCommand,
  type GitHubOptions,
  type GitHubPullRequest,
} from '../src/branch-github.ts'

const sha = 'a'.repeat(40)
const pr: GitHubPullRequest = {
  number: 7,
  url: 'https://github.com/example/project/pull/7',
  repository: 'example/project',
  branch: 'pi/task',
  target: 'main',
}
const request = {
  remoteUrl: 'git@github.com:example/project.git',
  branch: pr.branch,
  target: pr.target,
  title: 'Implement scoped task',
  body: 'Reviewed and tested by the Pi harness.\nEvidence is retained locally.\n',
}
const pull = (head = sha) => ({
  number: pr.number,
  html_url: pr.url,
  state: 'open',
  head: { sha: head, ref: pr.branch, repo: { full_name: pr.repository } },
  base: { ref: pr.target, repo: { full_name: pr.repository } },
})
const waitOptions = { timeoutMs: 1000, pollMs: 1, registrationGraceMs: 0 }

function endpoint(args: string[]): string {
  assert.equal(args[0], 'api')
  assert.equal(args[args.indexOf('--hostname') + 1], 'github.com')
  return args.find((arg) => arg.startsWith('repos/'))!
}

function checkRunner(
  change: (path: string, defaults: unknown, call: number) => unknown = (_path, defaults) =>
    defaults,
): GitHubCommand {
  let calls = 0
  return async (args) => {
    const path = endpoint(args)
    calls++
    let value: unknown = pull()

    if (path.includes('/reviews?')) {
      value = [[]]
    }

    if (path.includes('/commits/')) {
      assert.ok(args.includes('--paginate'))
      assert.ok(args.includes('--slurp'))
      assert.ok(path.includes(sha))

      if (path.includes('/check-runs')) {
        value = [{ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] }]
      } else if (path.includes('/check-suites')) {
        value = [{ check_suites: [] }]
      } else {
        value = [{ statuses: [{ context: 'security', state: 'success' }] }]
      }
    }

    return JSON.stringify(change(path, value, calls))
  }
}

test('supported GitHub remotes are recognized and local origins skip gh', async () => {
  for (const remote of [
    'https://github.com/example/project.git',
    'git@github.com:example/project.git',
    'ssh://git@github.com/example/project.git',
  ]) {
    assert.equal(githubRepository(remote), 'example/project')
  }

  for (const remote of ['/tmp/origin.git', 'https://github.com.evil/example/project.git']) {
    const result = await ensureBranchPullRequest({ ...request, remoteUrl: remote }, undefined, {
      run: async () => {
        throw new Error('A local remote must not invoke GitHub')
      },
    })
    assert.equal(result, undefined)
  }
})

test('PR creation uses structured input and existing matching PRs are reused', async () => {
  let created = 0
  const run: GitHubCommand = async (args, _signal, input) => {
    endpoint(args)

    if (args.includes('POST')) {
      created++
      assert.ok(args.includes('--input'))
      assert.deepEqual(JSON.parse(input!), {
        head: request.branch,
        base: request.target,
        title: request.title,
        body: request.body,
        draft: false,
      })
      return JSON.stringify(pull())
    }

    assert.ok(args.includes('--paginate'))
    return JSON.stringify(created ? [[], [pull()]] : [[]])
  }
  assert.deepEqual(await ensureBranchPullRequest(request, undefined, { run }), pr)
  assert.deepEqual(await ensureBranchPullRequest(request, undefined, { run }), pr)
  assert.equal(created, 1)
})

test('a raced PR creation reuses the independently created matching PR', async () => {
  let reads = 0
  const run: GitHubCommand = async (args) => {
    endpoint(args)

    if (args.includes('POST')) {
      throw new Error('HTTP 422: another request created the PR')
    }

    reads++
    return JSON.stringify(reads > 1 ? [[pull()]] : [[]])
  }
  assert.deepEqual(await ensureBranchPullRequest(request, undefined, { run }), pr)
})

test('PR reuse rejects the wrong repository, branch or target', async () => {
  for (const mismatch of [
    { ...pull(), head: { ...pull().head, repo: { full_name: 'attacker/project' } } },
    { ...pull(), head: { ...pull().head, ref: 'other' } },
    { ...pull(), base: { ...pull().base, ref: 'release' } },
  ]) {
    await assert.rejects(
      ensureBranchPullRequest(request, undefined, {
        run: async () => JSON.stringify([[mismatch]]),
      }),
      /does not match/,
    )
  }
})

test('GitHub checks bind every paginated result to the expected PR head', async () => {
  const run = checkRunner((path, defaults) =>
    path.includes('/check-runs')
      ? [
          { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] },
          { check_runs: [{ name: 'fuzz', status: 'completed', conclusion: 'success' }] },
        ]
      : defaults,
  )
  const receipt = await awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run })
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.head, sha)
  assert.deepEqual(receipt.checks.map((item) => item.name).sort(), ['fuzz', 'security', 'unit'])
})

test('stale PR heads are rejected both before and after reading CI', async () => {
  for (const at of ['before', 'after']) {
    let inspections = 0
    const run = checkRunner((path, defaults) => {
      if (!path.includes('/pulls/') || path.includes('/reviews?')) {
        return defaults
      }

      inspections++
      return at === 'before' || inspections > 1 ? pull('b'.repeat(40)) : defaults
    })
    await assert.rejects(
      awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run }),
      /head changed/,
    )
  }
})

test('failed, cancelled, skipped and neutral checks fail the merge gate', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    const run = checkRunner((path, defaults) =>
      path.includes('/check-runs')
        ? [{ check_runs: [{ name: 'unit', status: 'completed', conclusion }] }]
        : defaults,
    )
    await assert.rejects(
      awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run }),
      (error: unknown) => error instanceof GitHubChecksFailed && error.failures[0]?.name === 'unit',
    )
  }
})

test('pending check suites wait for successful completion', async () => {
  let polls = 0
  const run = checkRunner((path, defaults) => {
    if (!path.includes('/check-suites')) {
      return defaults
    }

    polls++
    return [
      {
        check_suites: [
          {
            app: { slug: 'actions' },
            status: polls > 1 ? 'completed' : 'queued',
            conclusion: polls > 1 ? 'success' : null,
          },
        ],
      },
    ]
  })
  assert.equal(
    (await awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run })).status,
    'passed',
  )
  assert.equal(polls, 2)
})

test('actionable failures include bounded logs only from the task repository', async () => {
  const base = checkRunner((path, defaults) =>
    path.includes('/check-runs')
      ? [
          {
            check_runs: [
              {
                name: 'unit',
                status: 'completed',
                conclusion: 'failure',
                details_url: 'https://github.com/example/project/actions/runs/42/job/1',
                output: { summary: 'Property counterexample: empty input.' },
              },
            ],
          },
        ]
      : defaults,
  )
  let logs = 0
  const run: GitHubCommand = async (args, signal, input) => {
    if (args[0] === 'run') {
      logs++
      assert.deepEqual(args, ['run', 'view', '42', '--log-failed', '--repo', 'example/project'])
      return 'x'.repeat(5000) + '\nAssertionError: empty input was accepted.'
    }

    return base(args, signal, input)
  }
  await assert.rejects(
    awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubChecksFailed)
      assert.equal(error.head, sha)
      assert.match(error.message, /Property counterexample/)
      assert.match(error.message, /AssertionError/)
      assert.ok(error.message.length < 5000)
      return true
    },
  )
  assert.equal(logs, 1)
})

test('the registration grace also catches a late failure after an early success', async () => {
  let polls = 0
  const run = checkRunner((path, defaults) => {
    if (!path.includes('/check-runs')) {
      return defaults
    }

    polls++
    return polls > 1
      ? [{ check_runs: [{ name: 'late-ci', status: 'completed', conclusion: 'failure' }] }]
      : defaults
  })
  await assert.rejects(
    awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run, registrationGraceMs: 10 }),
    /late-ci/,
  )
})

test('review objections survive comments and clear after a later approval', async () => {
  const review = {
    user: { id: 9, login: 'reviewer' },
    state: 'CHANGES_REQUESTED',
    commit_id: sha,
    body: 'Handle the empty input case.',
  }
  let approved = false
  const run = checkRunner((path, defaults) =>
    path.includes('/reviews?')
      ? [[review], [{ ...review, state: approved ? 'APPROVED' : 'COMMENTED' }]]
      : defaults,
  )
  await assert.rejects(
    awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run }),
    /Handle the empty input case/,
  )
  approved = true
  const receipt = await awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run })
  assert.equal(receipt.reviews[0]?.state, 'APPROVED')
})

test('empty CI observes registration grace and records none reported explicitly', async () => {
  let polls = 0
  const run = checkRunner((path, defaults) => {
    if (path.includes('/check-runs')) {
      polls++
      return [{ check_runs: [] }]
    }

    return path.includes('/status?') ? [{ statuses: [] }] : defaults
  })
  const receipt = await awaitBranchChecks(pr, sha, undefined, {
    ...waitOptions,
    run,
    registrationGraceMs: 10,
  })
  assert.equal(receipt.status, 'none_reported')
  assert.deepEqual(receipt.checks, [])
  assert.ok(polls > 1)
})

test('pending CI respects cancellation and the wait deadline', async () => {
  const run = checkRunner((path, defaults) =>
    path.includes('/status?') ? [{ statuses: [{ context: 'build', state: 'pending' }] }] : defaults,
  )
  const options: GitHubOptions = { ...waitOptions, run, timeoutMs: 10 }
  await assert.rejects(awaitBranchChecks(pr, sha, undefined, options), /abort|timeout/i)
  const controller = new AbortController()
  controller.abort(new Error('User cancelled'))
  await assert.rejects(awaitBranchChecks(pr, sha, controller.signal, options), /User cancelled/)
})

test('a known prior PR head may briefly lag a successful push', async () => {
  let inspections = 0
  const previousHead = 'b'.repeat(40)
  const run = checkRunner((path, defaults) => {
    if (path.endsWith('/pulls/7')) {
      inspections++
      return inspections < 3 ? pull(previousHead) : defaults
    }

    return defaults
  })
  const result = await awaitBranchChecks(pr, sha, undefined, {
    ...waitOptions,
    run,
    previousHead,
    headSyncTimeoutMs: 100,
  })
  assert.equal(result.head, sha)
  assert.equal(inspections, 4)
})

test('old PR heads time out and unrelated heads fail immediately', async () => {
  const previousHead = 'b'.repeat(40)

  for (const reportedHead of [previousHead, 'c'.repeat(40)]) {
    let inspections = 0
    const run = checkRunner((path, defaults) => {
      if (path.endsWith('/pulls/7')) {
        inspections++
        return pull(reportedHead)
      }

      return defaults
    })
    await assert.rejects(
      awaitBranchChecks(pr, sha, undefined, {
        ...waitOptions,
        run,
        previousHead,
        headSyncTimeoutMs: 10,
      }),
      /head changed/,
    )
    assert.ok(reportedHead === previousHead ? inspections > 1 : inspections === 1)
  }
})

test('ordinary CI and human reviews remain gates when agent reviews are separated', async () => {
  let humanObjection = false
  const run = checkRunner((path, defaults) => {
    if (path.includes('/check-runs')) {
      return [
        {
          check_runs: [
            {
              name: 'Codex review',
              app: { slug: 'github-actions' },
              check_suite: { id: 9 },
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        },
      ]
    }

    if (path.includes('/check-suites')) {
      return [
        {
          check_suites: [
            {
              id: 9,
              app: { slug: 'github-actions' },
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        },
      ]
    }

    if (path.includes('/reviews?')) {
      return [
        [
          {
            user: humanObjection
              ? { id: 2, login: 'claude-human', type: 'User' }
              : { id: 1, login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
            state: 'CHANGES_REQUESTED',
            commit_id: sha,
            body: 'Check the empty input.',
          },
        ],
      ]
    }

    return defaults
  })
  await assert.rejects(
    awaitBranchChecks(pr, sha, undefined, { ...waitOptions, run }),
    GitHubChecksFailed,
  )
  const options = { ...waitOptions, run, excludeAgentReviews: true }
  assert.equal((await awaitBranchChecks(pr, sha, undefined, options)).status, 'passed')
  humanObjection = true
  await assert.rejects(awaitBranchChecks(pr, sha, undefined, options), /review changes requested/)
})
