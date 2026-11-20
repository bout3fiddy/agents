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
