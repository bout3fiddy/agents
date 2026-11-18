import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, validateScope } from './paths.ts'
import { acquireLock, type ReleaseLock } from './lock.ts'
import { projectTraces } from './traces.ts'
import {
  validateDesign,
  type Checkpoint,
  type Design,
  type Receipt,
  type WorkerEvidence,
} from './contracts.ts'

export type TaskState = {
  id: string
  designHash: string
  designVersion?: number
  status: 'running' | 'needs_attention' | 'verified' | 'applying' | 'complete' | 'interrupted'
  phase: string
  round: number
  candidate?: string
  resumedFrom?: string
  snapshot?: string
  evidence: WorkerEvidence[]
  receipts: Receipt[]
  error?: string
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)

  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }

  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')

  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

export class StateStore {
  readonly directory: string

  constructor(
    readonly projectRoot: string,
    stateRoot?: string,
  ) {
    this.projectRoot = realpathSync(projectRoot)
    this.directory = stateRoot
      ? join(stateRoot, digest(this.projectRoot).slice(0, 24))
      : join(projectTraces(this.projectRoot), 'harness')
  }

  async draft(design: Design): Promise<string> {
    validateDesign(design)
    validateScope(design.writePaths)
    const hash = digest(JSON.stringify(design))
    await atomicJson(join(this.directory, 'draft.json'), { design, hash })
    return hash
  }

  async accept(expectedHash?: string): Promise<Checkpoint> {
    const draft = await readJson<{ design: Design; hash: string }>(
      join(this.directory, 'draft.json'),
    )

    if (!draft || (expectedHash && !draft.hash.startsWith(expectedHash))) {
      throw new Error('No matching current draft; inspect the proposed design before accepting')
    }

    validateDesign(draft.design)
    validateScope(draft.design.writePaths)

    if (digest(JSON.stringify(draft.design)) !== draft.hash) {
      throw new Error('Draft integrity check failed')
    }

    const checkpoint = await this.pin(draft.design)
    await rm(join(this.directory, 'draft.json'))
    return checkpoint
  }

  /** Freeze worker scope without changing the host conversation. Caller owns the project lock. */
  async pin(design: Design): Promise<Checkpoint> {
    validateDesign(design)
    validateScope(design.writePaths)
    const previous = await this.checkpoint()
    const checkpoint = {
      ...design,
      version: (previous?.version ?? 0) + 1,
      hash: digest(JSON.stringify(design)),
      acceptedAt: new Date().toISOString(),
    }
    await atomicJson(join(this.directory, 'designs', `${checkpoint.version}.json`), checkpoint)
    await atomicJson(join(this.directory, 'accepted.json'), checkpoint)
    return checkpoint
  }

  async checkpoint(): Promise<Checkpoint | undefined> {
    return readJson<Checkpoint>(join(this.directory, 'accepted.json'))
  }

  async task(): Promise<TaskState | undefined> {
    return readJson<TaskState>(join(this.directory, 'task.json'))
  }

  async saveTask(task: TaskState): Promise<void> {
    await atomicJson(join(this.directory, 'tasks', `${task.id}.json`), task)
    await atomicJson(join(this.directory, 'task.json'), task)
  }

  async lock(): Promise<ReleaseLock> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const release = await acquireLock(join(this.directory, 'workflow.lock'))

    try {
      const task = await this.task()

      if (task?.status === 'running' || task?.status === 'applying') {
        task.status = 'interrupted'
        task.error = 'Previous supervisor exited; completed evidence remains available'
        await this.saveTask(task)
      }
    } catch (error) {
      await release()
      throw error
    }

    return release
  }
}
