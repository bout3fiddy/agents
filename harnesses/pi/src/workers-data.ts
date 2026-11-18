import { lstat, open, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { StateStore, readJson } from './state.ts'
import { Delegations, activeTask, delegationDirectory } from './delegation-state.ts'
import type { Delegation } from './delegation-state.ts'
import {
  messageText,
  type ConversationEntry,
  type LiveWorkerInfo,
  type LiveWorkerState,
} from './worker-live.ts'
import { WorkerMailbox, type Guidance } from './worker-mailbox.ts'

export type WorkerRow = {
  id: string
  info: LiveWorkerInfo
  state: LiveWorkerState
  active: boolean
  directory?: string
  accepting: boolean
  taskStatus?: string
  branch?: string
  delegatedBy: string
  legacy?: boolean
  inferredRelationship?: boolean
  transcript?: string
  guidance: Guidance[]
}

export function taskTitle(raw: string): string {
  try {
    const value = JSON.parse(raw) as { task?: string; assignment?: string }
    return value.task ?? value.assignment ?? raw
  } catch {
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

/** Old coordinators can launch newly installed children without recording their parent IDs. */
function groupLegacyChildren(parent: WorkerRow, children: WorkerRow[]): void {
  for (const row of children) {
    if (row.info.parentId) {
      continue
    }

    const author = ['reviewer', 'database-reviewer', 'performance'].includes(row.info.role)
      ? children
          .filter(
            (candidate) =>
              ['implementer', 'task-worker'].includes(candidate.info.role) &&
              candidate.info.workspace === row.info.workspace &&
              candidate.state.status === 'complete' &&
              candidate.state.updatedAt <= row.info.startedAt,
          )
          .sort((left, right) => right.info.startedAt.localeCompare(left.info.startedAt))[0]
      : undefined
    row.info = {
      ...row.info,
      parentId: parent.id,
      reviewOf: row.info.reviewOf ?? author?.id,
    }
    row.inferredRelationship = true
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

async function safeTrace(store: StateStore, path: string): Promise<string> {
  const local = relative(store.directory, resolve(path))

  if (!local || local.startsWith('..') || local.startsWith(sep)) {
    throw new Error('Worker trace must stay in the project trace directory')
  }

  let cursor = store.directory

  for (const part of local.split(sep)) {
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

export class WorkersCatalog {
  readonly store: StateStore
  readonly jobs: Delegations
  private info = new Map<string, LiveWorkerInfo>()
  warnings: string[] = []

  constructor(
    root: string,
    private readonly onGuidance?: (row: WorkerRow, text: string) => void | Promise<void>,
  ) {
    this.store = new StateStore(root)
    this.jobs = new Delegations(this.store)
  }

  async list(): Promise<WorkerRow[]> {
    this.warnings = []
    const jobs = await this.jobs.list().catch((error: unknown) => {
      this.warnings.push(`Task registry: ${String(error)}`)
      return [] as Delegation[]
    })
    const rows: WorkerRow[] = []
    const directory = join(this.store.directory, 'workers')

    for (const id of await entries(directory)) {
      if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) {
        continue
      }

      try {
        const path = await safeTrace(this.store, join(directory, id))
        const info =
          this.info.get(id) ??
          (await readJson<LiveWorkerInfo>(await safeTrace(this.store, join(path, 'info.json'))))
        let state = await readJson<LiveWorkerState>(
          await safeTrace(this.store, join(path, 'state.json')),
        )

        if (!info || !state || info.id !== id || !Number.isSafeInteger(info.pid) || info.pid < 1) {
          continue
        }

        this.info.set(id, info)

        if (state.status === 'running' && !processExists(info.pid)) {
          state = {
            ...state,
            status: 'failed',
            stage: 'stopped',
            summary: 'Worker process stopped without a final receipt.',
          }
        }

        await safeTrace(this.store, join(path, 'mailbox.json'))
        const mailbox = await new WorkerMailbox(path).read()
        const summary = await readJson<{ summary: string }>(
          await safeTrace(this.store, `${info.output}.summary.json`),
        )

        if (state.status === 'running' && summary) {
          state = { ...state, summary: summary.summary }
        }

        const job = jobs.find((item) => item.request.id === info.taskId)
        rows.push({
          id,
          info,
          state,
          directory: path,
          active: state.status === 'running',
          accepting:
            state.status === 'running' && mailbox.accepting && (!job || activeTask(job.state)),
          taskStatus: job?.state.status,
          branch: job?.state.branch,
          delegatedBy: info.parentId ? `Worker ${info.parentId.slice(0, 8)}` : 'Orchestrator',
          guidance: mailbox.messages,
          transcript: join(path, 'conversation.jsonl'),
        })
      } catch (error) {
        this.warnings.push(`${id.slice(0, 8)}: ${String(error)}`)
      }
    }

    for (const job of jobs) {
      const children = rows.filter((row) => row.info.taskId === job.request.id)
      const covered = children.some((row) =>
        ['task-coordinator', 'branch-orchestrator'].includes(row.info.role),
      )

      if (covered || (job.request.kind === 'implementation' && children.length)) {
        continue
      }

      try {
        const parent = await this.legacy(job)
        rows.push(parent)
        groupLegacyChildren(parent, children)
      } catch (error) {
        this.warnings.push(`${job.request.id.slice(0, 8)}: ${String(error)}`)
      }
    }

    for (const row of rows) {
      const parent = rows.find((candidate) => candidate.id === row.info.parentId)

      if (parent) {
        row.delegatedBy = `${parent.info.role} · ${parent.info.id.slice(0, 8)}`
      }
    }

    return rows.sort((left, right) => right.info.startedAt.localeCompare(left.info.startedAt))
  }

  private async legacy(job: Delegation): Promise<WorkerRow> {
    const directory = delegationDirectory(this.store, job.request.id)
    const output = join(directory, job.state.progressFile ?? 'coordinator.json')
    const sessions = await safeTrace(this.store, `${output}.sessions`)
    const latest = (await entries(sessions))
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .at(-1)
    const activity = job.state.progress?.child ?? job.state.progress
    return {
      id: `task:${job.request.id}`,
      legacy: true,
      active: activeTask(job.state),
      accepting: activeTask(job.state),
      taskStatus: job.state.status,
      branch: job.state.branch,
      delegatedBy: `Orchestrator · ${job.request.session.slice(0, 8)}`,
      guidance: [],
      info: {
        id: job.request.id,
        taskId: job.request.id,
        role: job.request.kind === 'branch' ? 'branch-orchestrator' : 'task-coordinator',
        model: job.request.model,
        task: job.request.task,
        scope: job.request.writePaths,
        output,
        workspace: job.state.candidate ?? job.request.root,
        projectRoot: job.request.root,
        pid: job.state.pid ?? 0,
        startedAt: job.request.createdAt,
        backend: 'pi',
      },
      state: {
        status: activeTask(job.state)
          ? 'running'
          : job.state.status === 'complete'
            ? 'complete'
            : 'needs_attention',
        updatedAt: activity?.updatedAt ?? job.state.updatedAt,
        stage: `${job.state.status}${activity?.role ? ` · ${activity.role}` : ''}`,
        tool: activity?.tool,
        summary: job.state.summary ?? job.state.error,
      },
      transcript: latest ? join(sessions, latest) : undefined,
    }
  }

  async send(id: string, text: string): Promise<string> {
    const row = (await this.list()).find((item) => item.id === id)

    if (!row?.active || !row.accepting) {
      throw new Error('Worker is no longer accepting guidance. Return to its coordinator.')
    }

    if (row.legacy) {
      await this.jobs.control(row.info.taskId!, 'message', text)
      return 'Queued for the task coordinator; legacy children have no direct channel.'
    }

    const message = await new WorkerMailbox(row.directory!).send(text)
    let warning = ''

    try {
      if (row.info.parentId && row.info.taskId) {
        await this.jobs.control(row.info.taskId, 'message', text)
      }

      await this.onGuidance?.(row, text)
    } catch (error) {
      warning = ` Parent notification failed: ${String(error)}`
    }

    return (
      `Guidance ${message.id.slice(0, 8)} queued for this worker at its next safe boundary.` +
      warning
    )
  }

  async conversation(row: WorkerRow, bytes = 131072) {
    if (!row.transcript) {
      return { entries: [], truncated: false }
    }

    const path = await safeTrace(this.store, row.transcript)
    let file

    try {
      file = await open(path, 'r')
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

          if (row.legacy && value.message) {
            parsed.push({
              at: value.timestamp,
              role: value.message.role,
              text: messageText(value.message),
            })
          } else if (!row.legacy && typeof value.text === 'string') {
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
