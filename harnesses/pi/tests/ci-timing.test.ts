import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectCiRun } from '../src/ci-timing.ts'

const head = 'a'.repeat(40)
const at = (second: number) => new Date(second * 1000).toISOString()
const run = {
  id: 31,
  workflow_id: 7,
  run_attempt: 1,
  head_sha: head,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: at(0),
  run_started_at: at(1),
  updated_at: at(8),
}
const step = (name: string, start: number, finish: number) => ({
  name,
  started_at: at(start),
  completed_at: at(finish),
  status: 'completed',
  conclusion: 'success',
})
const jobs = [
  {
    ...step('tests', 1, 6),
    id: 41,
    created_at: at(0),
    run_attempt: 1,
    run_id: 31,
    steps: [step('setup', 1, 2), step('suite', 2, 6)],
  },
  { ...step('package', 5, 8), id: 42, created_at: at(5), run_attempt: 1, run_id: 31 },
]

function fixture(info = run, observed = jobs, total = observed.length) {
  const peers = [info, { ...info, id: 32, event: 'push' }, { ...info, id: 33, workflow_id: 6 }]
  return async (args: string[]) => {
    const base = 'repos/fixture/project/actions'
    const path = args.at(-1)

    if (path === base + '/runs/31') {
      return JSON.stringify(info)
    }

    if (path === base + '/runs/31/attempts/' + info.run_attempt + '/jobs?per_page=100') {
      return JSON.stringify({ total_count: total, jobs: observed })
    }

    assert.equal(path, base + '/workflows/7/runs?head_sha=' + head + '&per_page=25')
    return JSON.stringify({ total_count: peers.length + 1, workflow_runs: peers })
  }
}

test('timings distinguish wall time, overlapping jobs, setup and the last finisher', async () => {
  const report = await inspectCiRun('fixture/project', 31, undefined, fixture())
  assert.equal(report.wallMs, 8000)
  assert.equal(report.lastFinishingJob?.name, 'package')
  assert.equal(report.longestJobs[0]?.name, 'tests')
  assert.equal(report.longestJobs[0]?.createdToStartMs, 1000)
  assert.equal(report.longestJobs[0]?.longestSteps[0]?.elapsedMs, 4000)
  assert.deepEqual(
    report.sameHeadRuns.map((r) => r.runId),
    [32],
  )
  assert.equal(report.sameHeadListTruncated, true)
})

test('incomplete, paged and rerun evidence stays scoped to its own attempt', async () => {
  const report = (get: ReturnType<typeof fixture>) =>
    inspectCiRun('fixture/project', 31, undefined, get)
  const running = await report(fixture({ ...run, status: 'in_progress' }))
  assert.equal(running.wallMs, null)
  assert.equal(running.lastFinishingJob, null)
  const retry = { ...run, run_attempt: 2, run_started_at: at(60), updated_at: at(68) }
  const partial = await report(fixture(retry, [], 3))
  assert.equal(partial.wallMs, 8000)
  assert.equal(partial.lastFinishingJob, null)
  await assert.rejects(report(fixture(retry)), /another run or attempt/)
})
