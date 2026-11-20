import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { githubApi, type GitHubCommand } from './branch-github.ts'

const nullableText = Type.Union([Type.String(), Type.Null()])
const runSchema = Type.Object({
  id: Type.Integer(),
  workflow_id: Type.Integer(),
  run_attempt: Type.Integer(),
  head_sha: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  event: Type.String(),
  status: Type.String(),
  conclusion: nullableText,
  created_at: Type.String(),
  run_started_at: nullableText,
  updated_at: Type.String(),
})
const timing = {
  name: Type.String(),
  status: Type.String(),
  conclusion: nullableText,
  started_at: nullableText,
  completed_at: nullableText,
}
const jobsSchema = Type.Object({
  total_count: Type.Integer(),
  jobs: Type.Array(
    Type.Object({
      ...timing,
      id: Type.Integer(),
      run_id: Type.Integer(),
      run_attempt: Type.Integer(),
      created_at: Type.Optional(nullableText),
      steps: Type.Optional(Type.Array(Type.Object(timing))),
    }),
  ),
})
const runsSchema = Type.Object({
  total_count: Type.Integer(),
  workflow_runs: Type.Array(runSchema),
})

function duration(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return null
  }

  const ms = Date.parse(end) - Date.parse(start)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

export async function inspectCiRun(
  repository: string,
  runId: number,
  signal?: AbortSignal,
  run?: GitHubCommand,
) {
  const base = 'repos/' + repository + '/actions'
  const get = (path: string) => githubApi(base + path, signal, { run })
  const info = await get('/runs/' + runId)

  if (!Check(runSchema, info) || info.id !== runId) {
    throw new Error('Invalid Actions run identity')
  }

  const [page, peers] = await Promise.all([
    get(`/runs/${runId}/attempts/${info.run_attempt}/jobs?per_page=100`),
    get(`/workflows/${info.workflow_id}/runs?head_sha=${info.head_sha}&per_page=25`),
  ])

  if (!Check(jobsSchema, page) || !Check(runsSchema, peers)) {
    throw new Error('Invalid Actions timing evidence')
  }

  const jobs = page.jobs.map((job) => {
    if (job.run_id !== runId || job.run_attempt !== info.run_attempt) {
      throw new Error('Jobs belong to another run or attempt')
    }

    const steps = (job.steps ?? [])
      .map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        elapsedMs: duration(step.started_at, step.completed_at),
      }))
      .sort((a, b) => (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1))
    return {
      name: job.name,
      id: job.id,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      finishedAt: job.completed_at,
      createdToStartMs: duration(job.created_at, job.started_at),
      elapsedMs: duration(job.started_at, job.completed_at),
      longestSteps: steps.slice(0, 5),
    }
  })
  const byDuration = jobs.toSorted((a, b) => (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1))
  const finished = jobs
    .filter((j) => j.finishedAt && j.elapsedMs !== null)
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))
  const sameHeadRuns = peers.workflow_runs
    .filter(
      (r) => r.id !== runId && r.workflow_id === info.workflow_id && r.head_sha === info.head_sha,
    )
    .map((r) => ({
      runId: r.id,
      attempt: r.run_attempt,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
    }))

  return {
    repository,
    runId,
    attempt: info.run_attempt,
    event: info.event,
    head: info.head_sha,
    status: info.status,
    conclusion: info.conclusion,
    wallMs:
      info.status === 'completed'
        ? duration(info.run_attempt === 1 ? info.created_at : info.run_started_at, info.updated_at)
        : null,
    wallStart: info.run_attempt === 1 ? 'run creation' : 'attempt start',
    jobsObserved: jobs.length,
    jobsTotal: page.total_count,
    lastFinishingJob:
      info.status === 'completed' && jobs.length === page.total_count
        ? (finished[0] ?? null)
        : null,
    longestJobs: byDuration.slice(0, 8),
    sameHeadRuns,
    sameHeadListTruncated: peers.total_count > peers.workflow_runs.length,
  }
}
