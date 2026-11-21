import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A task-owned directory survives its creator only while the owning task can still resume. */
export type TaskOwner = { projectRoot: string; stateDirectory: string; taskId: string }

type OwnerRecord = TaskOwner & { pid: number; createdAt: number }

const hour = 60 * 60_000
const activeStatuses = new Set([
  'queued',
  'running',
  'checking',
  'applying',
  'publishing',
  'merge_queued',
  'merging',
])
const retainedStatuses = new Set(['needs_attention', 'paused', 'published', 'interrupted'])
let processDirectory: Promise<string> | undefined

export function temporaryRoot(): string {
  return join(tmpdir(), 'pi-harness')
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function ownedProcessDirectory(): Promise<string> {
  processDirectory ??= (async () => {
    const parent = join(temporaryRoot(), 'processes')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    return mkdtemp(join(parent, `${process.pid}-`))
  })()
  return processDirectory
}

/** Disposable directories belong to the creating process and are swept after it exits. */
export async function temporaryDirectory(prefix: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await mkdtemp(join(await ownedProcessDirectory(), `${prefix}-`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) {
        throw error
      }

      // The operating system can clear temporary storage while a long-lived process runs.
      processDirectory = undefined
    }
  }
}

/** Retained candidates record their owning task so a later sweep can judge them alone. */
export async function taskDirectory(prefix: string, owner: TaskOwner): Promise<string> {
  const parent = join(temporaryRoot(), 'tasks')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, `${prefix}-`))
  const record: OwnerRecord = { ...owner, pid: process.pid, createdAt: Date.now() }
  await writeFile(`${directory}.owner.json`, JSON.stringify(record), { mode: 0o600 })
  return directory
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined
    }

    throw error
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }

    throw error
  }
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

async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

type TaskRecord = { status?: string; updatedAt?: string; pid?: number }

/** Decide whether a retained directory still serves a task that can resume. */
export async function taskRetains(
  owner: TaskOwner,
  path: string,
  now: number,
  retentionMs: number,
): Promise<boolean> {
  if (!(await exists(owner.projectRoot)) || !(await exists(owner.stateDirectory))) {
    return false
  }

  const delegation = join(owner.stateDirectory, 'delegations', owner.taskId)
  const workflow = join(owner.stateDirectory, 'tasks', `${owner.taskId}.json`)

  if (await exists(join(delegation, 'expired.json'))) {
    return false
  }

  const status =
    (await readJsonFile<TaskRecord>(join(delegation, 'status.json'))) ??
    (await readJsonFile<TaskRecord>(workflow))

  if (!status?.status) {
    return false
  }

  if (activeStatuses.has(status.status) && status.pid && processAlive(status.pid)) {
    return true
  }

  if (!retainedStatuses.has(status.status) && !activeStatuses.has(status.status)) {
    return false
  }

  const updatedAt = Date.parse(status.updatedAt ?? '')

  if (Number.isFinite(updatedAt) && now - updatedAt > retentionMs) {
    return false
  }

  const references = [
    await readText(join(delegation, 'status.json')),
    await readText(join(delegation, 'workspace.json')),
    await readText(workflow),
  ].join('\n')
  return references.includes(path)
}

export type SweepOptions = {
  retentionMs: number
  now?: number
  legacyReferences?: ReadonlySet<string>
  dryRun?: boolean
}

export type SweepReport = { removed: string[]; kept: number }

async function remove(path: string, report: SweepReport, dryRun: boolean | undefined) {
  report.removed.push(path)

  if (!dryRun) {
    await rm(path, { recursive: true, force: true })
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

/** Remove abandoned harness temporary storage without touching live or resumable work. */
export async function sweepTemporary(options: SweepOptions): Promise<SweepReport> {
  const now = options.now ?? Date.now()
  const report: SweepReport = { removed: [], kept: 0 }
  const processes = join(temporaryRoot(), 'processes')

  for (const name of await entries(processes)) {
    const pid = Number(name.split('-')[0])

    if (pid === process.pid || processAlive(pid)) {
      report.kept++
      continue
    }

    await remove(join(processes, name), report, options.dryRun)
  }

  const tasks = join(temporaryRoot(), 'tasks')
  const names = await entries(tasks)

  for (const name of names.filter((entry) => !entry.endsWith('.owner.json'))) {
    const path = join(tasks, name)
    const owner = await readJsonFile<OwnerRecord>(`${path}.owner.json`)
    const created = owner?.createdAt ?? (await modifiedAt(path)) ?? now
    const inUse = owner ? processAlive(owner.pid) : now - created < hour

    if (inUse || (owner && (await taskRetains(owner, path, now, options.retentionMs)))) {
      report.kept++
      continue
    }

    await remove(path, report, options.dryRun)
    await remove(`${path}.owner.json`, report, options.dryRun)
  }

  for (const name of names.filter((entry) => entry.endsWith('.owner.json'))) {
    if (!names.includes(name.slice(0, -'.owner.json'.length))) {
      await remove(join(tasks, name), report, options.dryRun)
    }
  }

  // Releases before this sweep wrote copies directly below the temporary directory.
  for (const name of await entries(tmpdir())) {
    if (!/^pi-(?:workspace|command)-[A-Za-z0-9_]{6}$/.test(name)) {
      continue
    }

    const path = join(tmpdir(), name)
    const modified = await modifiedAt(path)

    if (
      modified === undefined ||
      now - modified < options.retentionMs ||
      options.legacyReferences?.has(name)
    ) {
      report.kept++
      continue
    }

    await remove(path, report, options.dryRun)
  }

  return report
}
