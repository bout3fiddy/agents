import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { jobStore } from './job-tools.ts'
import { jobLabel, type Job, type JobStore } from './job-store.ts'
import { readJson, StateStore } from './state.ts'
import type { ConversationEntry, LiveWorkerInfo, LiveWorkerState } from './worker-live.ts'
import { WorkerMailbox, type Guidance } from './worker-mailbox.ts'

export type WorkerRow = {
  id: string
  info: LiveWorkerInfo
  state: LiveWorkerState
  active: boolean
  directory?: string
  accepting: boolean
  title?: string
  taskStatus?: string
  branch?: string
  delegatedBy: string

  /** The job itself, shown while no worker of it is running: queued, checking or delivering. */
  job?: string
  transcript?: string
  guidance: Guidance[]
}

export function taskTitle(raw: string): string {
  try {
    const value = JSON.parse(raw) as { task?: string; assignment?: string }
    return value.task ?? value.assignment ?? raw
  } catch {

    // Display-only parse; malformed JSON renders as raw text.
    return raw
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const workerId = /^[a-f0-9]{8}-[a-f0-9-]{27}$/

/**
 * The workers of a repository's jobs, read from the files each worker writes and the job store.
 * Rows are addressed by ID: a caller never supplies a directory.
 */
export class WorkersCatalog {
  warnings: string[] = []
  private readonly store: JobStore

  constructor(
    cwd: string,
    private readonly onGuidance?: (row: WorkerRow, text: string) => void | Promise<void>,
    private readonly session?: string,
  ) {
    this.store = jobStore(cwd)
  }

  private async worker(directory: string, id: string, jobs: Map<string, Job>) {
    const path = join(directory, id)
    const info = await readJson<LiveWorkerInfo>(join(path, 'info.json'))
    let state = await readJson<LiveWorkerState>(join(path, 'state.json'))
    const job = info?.taskId ? jobs.get(info.taskId) : undefined

    if (!info || !state || info.id !== id || !job) {
      return undefined
    }

    if (state.status === 'running' && !processExists(info.pid)) {
      state = {
        ...state,
        status: 'failed',
        stage: 'stopped',
        summary: 'Worker process stopped without a final result.',
      }
    }

    const mailbox = await new WorkerMailbox(path).read()
    const running = state.status === 'running'
    const row: WorkerRow = {
      id,
      info,
      state,
      directory: path,
      active: running,
      accepting: running && mailbox.accepting && job.status === 'running',
      title: `${jobLabel(job)} ${job.spec.title}`,
      taskStatus: job.status,
      branch: job.spec.branch,
      delegatedBy: `Job ${jobLabel(job)}`,
      guidance: mailbox.messages,
      transcript: join(path, 'conversation.jsonl'),
    }
    return row
  }

  /** A job with no running worker still has a row, so queued and checking work stays visible. */
  private jobRow(job: Job): WorkerRow {
    return {
      id: `job:${job.id}`,
      job: job.id,
      info: {
        id: job.id,
        taskId: job.id,
        role: 'job',
        model: job.spec.model,
        task: job.spec.task,
        scope: job.spec.writePaths,
        output: '',
        workspace: job.root,
        projectRoot: job.root,
        pid: job.pid ?? 0,
        startedAt: job.createdAt,
        backend: 'pi',
      },
      state: { status: 'running', updatedAt: job.updatedAt, stage: job.phase },
      active: true,
      accepting: true,
      title: `${jobLabel(job)} ${job.spec.title}`,
      taskStatus: job.status,
      branch: job.spec.branch,
      delegatedBy: 'Orchestrator',
      guidance: [],
    }
  }

  async list(): Promise<WorkerRow[]> {
    this.warnings = []
    this.store.reconcile()
    const jobs = this.store.list({ session: this.session })
    const byId = new Map(jobs.map((job) => [job.id, job]))
    const rows: WorkerRow[] = []

    for (const root of new Set(jobs.map((job) => job.root))) {
      const directory = join(new StateStore(root).directory, 'workers')

      for (const id of await readdir(directory).catch(() => [] as string[])) {
        if (!workerId.test(id)) {
          continue
        }

        try {
          const row = await this.worker(directory, id, byId)

          if (row) {
            rows.push(row)
          }
        } catch (error) {
          this.warnings.push(`${id.slice(0, 8)}: ${String(error)}`.slice(0, 300))
        }
      }
    }

    for (const job of jobs) {
      const working = rows.some((row) => row.info.taskId === job.id && row.active)

      if ((job.status === 'queued' || job.status === 'running') && !working) {
        rows.push(this.jobRow(job))
      }
    }

    return rows.sort((left, right) => right.info.startedAt.localeCompare(left.info.startedAt))
  }

  private async row(id: string): Promise<WorkerRow> {
    const row = (await this.list()).find((item) => item.id === id)

    if (!row) {
      throw new Error('Worker is no longer available')
    }

    return row
  }

  async send(id: string, text: string): Promise<string> {
    const row = await this.row(id)

    if (!row.active || !row.accepting) {
      throw new Error('This worker has finished. Guide its job from the conversation instead.')
    }

    if (row.job) {
      this.store.addMessage(row.job, text)
      await this.onGuidance?.(row, text)
      return 'Guidance held for the next round of this job.'
    }

    const message = await new WorkerMailbox(row.directory!).send(text)
    await this.onGuidance?.(row, text)
    return `Guidance ${message.id.slice(0, 8)} queued for this worker at its next safe boundary.`
  }

  async conversation(selected: WorkerRow, bytes = 131072) {
    const row = await this.row(selected.id)

    if (!row.transcript) {
      return { entries: [], truncated: false }
    }

    let file

    try {
      file = await open(row.transcript, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], truncated: false }
      }

      throw error
    }

    try {
      const size = (await file.stat()).size
      const offset = Math.max(0, size - Math.min(bytes, 2_000_000))
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')

      if (offset) {
        lines.shift()
      }

      lines.pop() // Only complete JSONL records are visible.
      const parsed: ConversationEntry[] = []

      for (const line of lines) {
        try {
          const value = JSON.parse(line)

          if (typeof value.text === 'string') {
            parsed.push(value)
          }
        } catch {
          // A damaged record must not hide subsequent intact conversation entries.
        }
      }

      return { entries: parsed, truncated: offset > 0 }
    } finally {
      await file.close()
    }
  }
}
