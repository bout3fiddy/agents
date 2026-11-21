import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Delegations, type DelegationStatus } from './delegation-state.ts'
import { gitCommand } from './git-branches.ts'
import { atomicJson, readJson, StateStore, type TaskState } from './state.ts'
import { processAlive, sweepTemporary, temporaryRoot, type SweepReport } from './temp.ts'

export const defaultRetentionMs = 48 * 60 * 60_000
const baselineGraceMs = 6 * 60 * 60_000
const activeStatuses = new Set([
  'queued',
  'running',
  'checking',
  'applying',
  'publishing',
  'merge_queued',
  'merging',
])
const terminalStatuses = new Set(['complete', 'cancelled', 'failed'])
const legacyName = /pi-(?:workspace|command)-[A-Za-z0-9_]{6}/g

export type PruneOptions = { retentionMs: number; now?: number; dryRun?: boolean }

export type PruneReport = {
  worktrees: string[]
  baselines: string[]
  hostWorktrees: string[]
  branches: string[]
  workspaces: string[]
  expired: string[]
  references: Set<string>
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function age(path: string, now: number): Promise<number> {
  return now - (await lstat(path)).mtimeMs
}

/** Only directories the harness created in temporary storage may be deleted by path. */
function temporaryCopy(path: string | undefined): path is string {
  if (!path) {
    return false
  }

  return [tmpdir(), temporaryRoot()].some((root) => {
    const inside = relative(root, path)
    return Boolean(inside) && !inside.startsWith('..') && !inside.startsWith(sep)
  })
}

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    return await gitCommand(root, args)
  } catch {
    return undefined
  }
}

async function removeWorktree(root: string, path: string, dryRun: boolean | undefined) {
  if (dryRun) {
    return
  }

  if ((await git(root, ['worktree', 'remove', '--force', '--', path])) === undefined) {
    await rm(path, { recursive: true, force: true })
  }
}

async function mainReference(root: string): Promise<string | undefined> {
  for (const ref of ['refs/remotes/origin/main', 'refs/heads/main']) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', ref])) !== undefined) {
      return ref
    }
  }

  return undefined
}

/** Keep uncommitted candidate edits recoverable before an expired worktree is removed. */
async function savePatch(worktree: string, destination: string): Promise<boolean> {
  if ((await git(worktree, ['add', '-A'])) === undefined) {
    return false
  }

  const changed = await git(worktree, ['diff', '--cached', '--name-only', 'HEAD'])

  if (!changed) {
    return false
  }

  return (
    (await git(worktree, ['diff', '--cached', '--binary', '--output=' + destination, 'HEAD'])) !==
    undefined
  )
}

type Decision = 'live' | 'retained' | 'terminal' | 'stale'

function decide(
  state: { status: string; pid?: number; updatedAt?: string },
  options: PruneOptions,
): Decision {
  const now = options.now ?? Date.now()
  const stopping = activeStatuses.has(state.status) || state.status === 'cancelled'

  if (stopping && state.pid && processAlive(state.pid)) {
    return 'live'
  }

  if (terminalStatuses.has(state.status)) {
    return 'terminal'
  }

  const updatedAt = Date.parse(state.updatedAt ?? '')
  return Number.isFinite(updatedAt) && now - updatedAt <= options.retentionMs ? 'retained' : 'stale'
}

async function pruneDelegation(
  store: StateStore,
  id: string,
  options: PruneOptions,
  report: PruneReport,
  main: string | undefined,
) {
  const root = store.projectRoot
  const directory = join(store.directory, 'delegations', id)
  const state = await readJson<DelegationStatus>(join(directory, 'status.json'))
  const retained = await readJson<{ workspace?: string; originals?: string }>(
    join(directory, 'workspace.json'),
  )

  if (!state?.status || (await exists(join(directory, 'expired.json')))) {
    return
  }

  const decision = decide(state, options)
  const worktree = join(store.directory, 'worktrees', id)

  if (decision === 'live' || decision === 'retained') {
    for (const path of [retained?.workspace, retained?.originals, state.candidate]) {
      for (const name of path?.match(legacyName) ?? []) {
        report.references.add(name)
      }
    }

    return
  }

  let patch = false

  if (await exists(worktree)) {
    if (decision === 'stale' && !options.dryRun) {
      patch = await savePatch(worktree, join(directory, 'expired.patch'))
    }

    await removeWorktree(root, worktree, options.dryRun)
    report.worktrees.push(worktree)
  }

  for (const path of [retained?.workspace, retained?.originals, state.candidate]) {
    if (temporaryCopy(path) && (await exists(path))) {
      report.workspaces.push(path)

      if (!options.dryRun) {
        await rm(path, { recursive: true, force: true })
      }
    }
  }

  const branch = `pi/${id}`

  if (
    main &&
    (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== undefined &&
    (await git(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, main])) !== undefined
  ) {
    report.branches.push(branch)

    if (!options.dryRun) {
      await git(root, ['branch', '-D', '--', branch])
    }
  }

  if (decision !== 'stale') {
    return
  }

  report.expired.push(id)

  if (options.dryRun) {
    return
  }

  const hours = Math.round(options.retentionMs / (60 * 60_000))
  const reason =
    `Retained work expired after ${hours} hours without activity.` +
    (patch ? ' Uncommitted changes are saved in expired.patch.' : '') +
    ' Start a replacement task to continue.'
  await atomicJson(join(directory, 'expired.json'), {
    expiredAt: new Date(options.now ?? Date.now()).toISOString(),
    previousStatus: state.status,
    patch: patch ? join(directory, 'expired.patch') : undefined,
    reason,
  })
  await atomicJson(join(directory, 'status.json'), {
    ...state,
    status: state.status === 'paused' ? 'paused' : 'needs_attention',
    candidate: undefined,
    error: reason,
  })
}

async function pruneWorkflowTasks(store: StateStore, options: PruneOptions, report: PruneReport) {
  for (const name of await entries(join(store.directory, 'tasks'))) {
    if (!name.endsWith('.json') || name.includes('.baseline')) {
      continue
    }

    const task = await readJson<TaskState & { updatedAt?: string }>(
      join(store.directory, 'tasks', name),
    )

    if (!task?.candidate) {
      continue
    }

    const modified = (await lstat(join(store.directory, 'tasks', name))).mtime.toISOString()
    const decision = decide({ status: task.status, updatedAt: modified }, options)

    if (decision === 'retained' || decision === 'live') {
      for (const legacy of task.candidate.match(legacyName) ?? []) {
        report.references.add(legacy)
      }

      continue
    }

    if (temporaryCopy(task.candidate) && (await exists(task.candidate))) {
      report.workspaces.push(task.candidate)

      if (!options.dryRun) {
        await rm(task.candidate, { recursive: true, force: true })
      }
    }
  }
}

/** Remove Pi-owned worktrees, baselines and copies that no live or resumable task needs. */
export async function pruneProject(store: StateStore, options: PruneOptions) {
  const now = options.now ?? Date.now()
  const report: PruneReport = {
    worktrees: [],
    baselines: [],
    hostWorktrees: [],
    branches: [],
    workspaces: [],
    expired: [],
    references: new Set(),
  }
  const root = store.projectRoot
  const repository = (await git(root, ['rev-parse', '--git-common-dir'])) !== undefined
  const main = repository ? await mainReference(root) : undefined
  const jobs = new Delegations(store)
  const live = new Set<string>()

  for (const id of await entries(join(store.directory, 'delegations'))) {
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      continue
    }

    // The registry lock orders this decision with resume, revision and dispatch.
    await jobs.locked(() => pruneDelegation(store, id, { ...options, now }, report, main))
    const state = await readJson<DelegationStatus>(
      join(store.directory, 'delegations', id, 'status.json'),
    )

    if (state && decide(state, { ...options, now }) === 'live') {
      live.add(id)
    }
  }

  await pruneWorkflowTasks(store, { ...options, now }, report)

  for (const name of await entries(join(store.directory, 'baselines'))) {
    const path = join(store.directory, 'baselines', name)
    const owner = name.slice(0, 36)

    if (live.has(owner) || (await age(path, now)) < baselineGraceMs) {
      continue
    }

    report.baselines.push(path)
    await removeWorktree(root, path, options.dryRun)
  }

  for (const name of await entries(join(store.directory, 'host-worktrees'))) {
    const path = join(store.directory, 'host-worktrees', name)

    if ((await age(path, now)) < options.retentionMs) {
      continue
    }

    const status = await git(path, ['status', '--porcelain', '--untracked-files=normal'])

    if (status === '') {
      report.hostWorktrees.push(path)
      await removeWorktree(root, path, options.dryRun)
    }
  }

  if (repository && !options.dryRun) {
    await git(root, ['worktree', 'prune'])
  }

  return report
}

export type CleanupReport = Omit<PruneReport, 'references'> & { temporary: SweepReport }

/** One cleanup pass for a project and the shared temporary storage. */
export async function cleanup(store: StateStore, options: PruneOptions): Promise<CleanupReport> {
  const { references, ...project } = await pruneProject(store, options)
  const temporary = await sweepTemporary({
    retentionMs: options.retentionMs,
    now: options.now,
    dryRun: options.dryRun,
    legacyReferences: references,
  })
  return { ...project, temporary }
}

export function cleanupSummary(report: CleanupReport, dryRun = false): string {
  const parts = [
    [report.worktrees.length, 'task worktrees'],
    [report.baselines.length, 'baseline worktrees'],
    [report.hostWorktrees.length, 'host worktrees'],
    [report.workspaces.length, 'retained copies'],
    [report.branches.length, 'merged branches'],
    [report.expired.length, 'expired tasks'],
    [report.temporary.removed.filter((path) => !path.endsWith('.owner.json')).length, 'temp dirs'],
  ] as const
  const removed = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`)
  return removed.length
    ? (dryRun ? 'Would clean ' : 'Cleaned ') + removed.join(', ')
    : 'Nothing to clean'
}

export function retentionMs(environment: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(environment.PI_HARNESS_RETENTION_HOURS)
  return Number.isFinite(hours) && hours >= 1 ? hours * 60 * 60_000 : defaultRetentionMs
}

const cleanupInterval = 60 * 60_000
const firstCleanupDelay = 60_000

/** Clean up while the host is idle: one minute after session start, then hourly. */
export function registerCleanup(pi: ExtensionAPI) {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let next = 0

  const run = (ctx: ExtensionContext, force = false, dryRun = false) => {
    if (running || (!force && Date.now() < next)) {
      return running
    }

    next = Date.now() + cleanupInterval
    running = (async () => {
      const store = new StateStore(await realpath(ctx.cwd))
      const startedAt = new Date().toISOString()

      try {
        const report = await cleanup(store, { retentionMs: retentionMs(), dryRun })
        const summary = cleanupSummary(report, dryRun)
        await atomicJson(join(store.directory, 'cleanup.json'), {
          startedAt,
          dryRun,
          summary,
          ...report,
        })

        if (force) {
          ctx.ui.notify(summary, 'info')
        }
      } catch (error) {
        await atomicJson(join(store.directory, 'cleanup.json'), { startedAt, error: String(error) })

        if (force) {
          ctx.ui.notify('Cleanup failed: ' + String(error), 'error')
        }
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  const idle = (ctx: ExtensionContext) => {
    try {
      return ctx.isIdle() && !ctx.hasPendingMessages()
    } catch {
      return false
    }
  }

  pi.on('session_start', (_event, ctx) => {
    next = Date.now() + firstCleanupDelay
    clearInterval(timer)
    timer = setInterval(() => {
      if (idle(ctx)) {
        void run(ctx)
      }
    }, 30_000)
    timer.unref()
  })
  pi.on('session_shutdown', async () => {
    clearInterval(timer)
    await running
  })
  pi.registerCommand('harness-cleanup', {
    description: 'Remove finished or expired Pi worktrees and temporary copies (--dry-run)',
    async handler(args, ctx) {
      await run(ctx, true, String(args ?? '').includes('--dry-run'))
    },
  })
}
