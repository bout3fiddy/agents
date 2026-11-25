import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'
import { acquireLock } from './lock.ts'
import { readBoundedFile } from './paths.ts'
import { atomicJson, StateStore } from './state.ts'
import {
  delegationDirectory,
  type DelegationRequest,
  type DelegationStatus,
} from './delegation-state.ts'

export type WorkerOrigin = { root: string; taskId: string; session: string }
const maxOrigins = 128
const maxBytes = 128 * 1024
const retentionMs = 30 * 86400000

/** Even missing leaves must have no linked ancestors, including the trace directory itself. */
export async function safeTrace(store: StateStore, path: string): Promise<string> {
  const local = relative(store.directory, resolve(path))

  if (!local || local.startsWith('..') || local.startsWith(sep)) {
    throw new Error('Worker trace must stay in the project trace directory')
  }

  // An external StateStore namespace is host supplied and may have an OS alias (e.g. /var).
  // Its per-project directory is not trusted. Project-local traces also check .pi and traces.
  const directory = resolve(store.directory)
  const external = relative(store.projectRoot, directory).split(sep)[0] === '..'
  return unlinkedPath(external ? dirname(directory) : store.projectRoot, path)
}

async function unlinkedPath(anchor: string, path: string): Promise<string> {
  let cursor = anchor

  for (const part of relative(cursor, resolve(path)).split(sep)) {
    cursor = join(cursor, part)

    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error('Linked worker traces are unavailable')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  return cursor
}

async function metadata<T>(store: StateStore, path: string, limit = maxBytes): Promise<T> {
  return JSON.parse((await readBoundedFile(await safeTrace(store, path), limit)).toString()) as T
}

export class WorkerRoots {
  private readonly index: StateStore

  constructor(
    readonly origin: StateStore,
    agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent'),
  ) {
    this.index = new StateStore(origin.projectRoot, join(agentDir, 'worker-origins'), false)
  }

  get path() {
    return join(this.index.directory, 'index.json')
  }

  private indexFile(path: string) {

    // Registry ancestors are not trusted store namespaces, even outside the origin project.
    return unlinkedPath(parse(resolve(path)).root, path)
  }

  async entries(): Promise<WorkerOrigin[]> {
    try {
      const path = await this.indexFile(this.path)
      const entries = JSON.parse((await readBoundedFile(path, maxBytes)).toString())

      if (!Array.isArray(entries) || entries.length > maxOrigins) {
        throw new Error('Invalid Workers index')
      }

      return entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }

      throw error
    }
  }

  async owner(entry: WorkerOrigin, registering = false) {
    if (
      !entry ||
      typeof entry.root !== 'string' ||
      !entry.session ||
      typeof entry.session !== 'string' ||
      entry.session.length > 256 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.taskId) ||
      (await realpath(entry.root)) !== entry.root
    ) {
      throw new Error('Invalid Workers registration')
    }

    const store = new StateStore(entry.root, undefined, false)
    const directory = delegationDirectory(store, entry.taskId)
    const request = await metadata<DelegationRequest>(
      store,
      join(directory, 'request.json'),
      2000000,
    )

    if (
      request.root !== entry.root ||
      request.id !== entry.taskId ||
      (request.originSession ?? request.session) !== entry.session ||
      (request.originRoot && request.originRoot !== this.origin.projectRoot)
    ) {
      throw new Error('Workers task provenance mismatch')
    }

    const state = await metadata<DelegationStatus>(store, join(directory, 'status.json'))
    const output = state.progressFile ?? 'coordinator.json'

    if (state.id !== entry.taskId || basename(output) !== output) {
      throw new Error('Invalid Workers task state')
    }

    for (const name of [`${output}.summary.json`, `${output}.progress.json`, 'controls.json']) {
      await safeTrace(store, join(directory, name))
    }

    await safeTrace(store, join(store.directory, 'delegations.lock'))
    await safeTrace(store, join(store.directory, 'delegations/pending-revision.json'))
    const receipt = await safeTrace(store, join(directory, 'workers-origin.json'))

    if (!request.originRoot) {
      if (registering) {
        try {
          await writeFile(receipt, JSON.stringify(this.origin.projectRoot), {
            flag: 'wx',
            mode: 0o600,
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error
          }
        }
      }

      if ((await metadata<string>(store, receipt)) !== this.origin.projectRoot) {
        throw new Error('Origin mismatch')
      }
    }

    return { store, state }
  }

  async register(entry: WorkerOrigin): Promise<void> {
    entry = { ...entry, root: await realpath(entry.root) }
    await this.owner(entry, true)

    if (entry.root === this.origin.projectRoot) {
      return
    }

    const lock = await this.indexFile(this.path + '.lock')
    await mkdir(this.index.directory, { recursive: true, mode: 0o700 })
    const release = await acquireLock(lock)

    try {
      const entries = await this.entries()

      if (
        entries.some(
          (item) =>
            item?.root === entry.root &&
            item.taskId === entry.taskId &&
            item.session === entry.session,
        )
      ) {
        return
      }

      const kept: WorkerOrigin[] = []

      for (const item of entries) {
        try {
          const { state } = await this.owner(item)

          if (
            state.status === 'complete' &&
            Date.parse(state.updatedAt) < Date.now() - retentionMs
          ) {
            continue
          }
        } catch {
          // An unreadable owner might still be active. Never prune it as completed.
        }

        kept.push(item)
      }

      kept.push(entry)

      if (
        kept.length > maxOrigins ||
        Buffer.byteLength(JSON.stringify(kept, null, 2)) + 1 > maxBytes
      ) {
        throw new Error('Workers origin index is full; inspect stale registrations')
      }

      await atomicJson(this.path, kept)
    } finally {
      await release()
    }
  }
}
