import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { StateStore } from './state.ts'
import { activeTask, Delegations, type Delegation } from './delegation-state.ts'
import { worktrees } from './memory-repository.ts'
import type { MemoryStore } from './memory-store.ts'

export function taskObservation(job: Delegation) {
  const { state, request } = job
  return {
    task: request.id,
    title: (request.title || request.task).slice(0, 240),
    observed: state.status,
    branch: state.branch,
    commit: state.commit,
    base: state.base,
    candidate: state.candidate,
    checks: state.receipts?.slice(-5).map((r) => ({
      name: r.check,
      status: r.status,
      snapshot: r.snapshot,
    })),
    reason: (state.error || state.summary)?.slice(0, 320),
    source: join(request.root, '.pi/traces/harness/delegations', request.id, 'status.json'),
    updated: state.updatedAt,
  }
}

// Re-read the owning records. Registering a second host must not initialize another checkout.
export async function ownerBrief(
  root: string,
  cwd: string,
  db: MemoryStore,
  localJobs?: Delegation[],
  lookupId?: string,
) {
  const trees = await worktrees(root)
  const hosts = new Set([
    cwd,
    trees[0],
    ...db
      .hosts()
      .filter((path) => trees.some((tree) => path === tree || path.startsWith(tree + '/'))),
  ])
  const paths = [...hosts].filter((p): p is string => !!p)
  const owners = await Promise.allSettled(
    paths.map(async (host) => {
      const dir = join(host, '.pi/traces/harness')

      if ((await realpath(dir).catch(() => undefined)) !== dir) {
        return undefined
      }

      const store = new StateStore(host, undefined, false)
      const [design, task, jobs] = await Promise.all([
        store.checkpoint(),
        store.task(),
        host === cwd && localJobs ? localJobs : new Delegations(store).list(),
      ])

      if (!design && !task && !jobs.length) {
        return undefined
      }

      const relevant = jobs
        .filter((j) => !j.request.recurring?.audit)
        .sort(
          (a, b) =>
            Number(activeTask(b.state)) - Number(activeTask(a.state)) ||
            b.state.updatedAt.localeCompare(a.state.updatedAt),
        )
      return {
        host,
        design: design && {
          hash: design.hash,
          objective: design.objective,
          success: design.acceptance,
          unresolved: design.unresolved,
          source: join(dir, 'designs', design.version + '.json'),
        },
        workflow: task && {
          designHash: task.designHash,
          status: task.status,
          candidate: task.candidate,
          phase: task.phase,
          source: join(dir, 'tasks', task.id + '.json'),
        },
        jobs: (lookupId
          ? relevant.filter((j) => j.request.id === lookupId)
          : relevant.slice(0, 10)
        ).map(taskObservation),
        otherJobs: Math.max(0, relevant.length - 10),
      }
    }),
  )
  return owners
    .map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : { host: paths[i], unavailable: 'Worker or design receipts could not be read', jobs: [] },
    )
    .filter(Boolean)
}

type Owner = NonNullable<Awaited<ReturnType<typeof ownerBrief>>[number]>

// Owners show a rolling window of jobs. Falling out of the window does not imply completion.
export function ownerChanges(previous: (Owner | undefined)[], current: (Owner | undefined)[]) {
  const remaining = new Map(
    previous.flatMap((owner) => (owner ? [[owner.host, owner] as const] : [])),
  )
  const changed: object[] = []

  for (const owner of current) {
    if (!owner) {
      continue
    }

    const prior = remaining.get(owner.host)
    remaining.delete(owner.host)

    if (!prior) {
      changed.push(owner)
      continue
    }

    const fields: Record<string, unknown> = {}
    const before = new Map(Object.entries(prior))
    const after = new Map(Object.entries(owner))

    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (key === 'jobs') {
        continue
      }

      const value = after.get(key)

      if (JSON.stringify(value) !== JSON.stringify(before.get(key))) {
        fields[key] = value ?? null
      }
    }

    const jobs = new Map(prior.jobs.map((job) => [job.task, job]))
    const updates = owner.jobs.filter((job) => {
      const old = jobs.get(job.task)
      jobs.delete(job.task)

      // Heartbeats can refresh the timestamp while every planning fact stays the same.
      return !old || JSON.stringify(job) !== JSON.stringify({ ...old, updated: job.updated })
    })

    if (updates.length) {
      fields.jobs = updates
    }

    if (jobs.size) {
      fields.jobsNoLongerListed = [...jobs.keys()]
    }

    if (Object.keys(fields).length) {
      changed.push({ host: owner.host, ...fields })
    }
  }

  return [...changed, ...Array.from(remaining.keys(), (host) => ({ host, noLongerListed: true }))]
}
