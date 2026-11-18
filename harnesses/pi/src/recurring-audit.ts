import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Delegation, DelegationRequest } from './delegation-state.ts'
import type { WorkerResult } from './contracts.ts'
import { digest } from './paths.ts'
import { atomicJson } from './state.ts'
import { projectTraces } from './traces.ts'

export type AuditCursor = { sessions: Record<string, string>; jobs: Record<string, string> }
export const emptyCursor = (): AuditCursor => ({ sessions: {}, jobs: {} })

type Branch = ReturnType<ExtensionContext['sessionManager']['getBranch']>

function discussions(entries: Branch) {
  const turns: { id: string; user: string; answer: string }[] = []
  let user: { id: string; text: string } | undefined

  for (const entry of entries) {
    if (entry.type !== 'message') {
      continue
    }

    const message = entry.message

    if (message.role === 'user') {
      const content = message.content
      const text =
        typeof content === 'string'
          ? content
          : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
      user = { id: entry.id, text: text.slice(0, 1000) }
    }

    if (user && message.role === 'assistant' && message.stopReason === 'stop') {
      turns.push({
        id: user.id,
        user: user.text,
        answer: message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .slice(0, 1400),
      })
      user = undefined
    }
  }

  return turns
}

export function auditDelta(
  previous: AuditCursor,
  session: string,
  entries: Branch,
  jobs: Delegation[],
) {
  const cursor = structuredClone(previous)
  const retained = new Set(jobs.map((job) => job.request.id))

  for (const id of Object.keys(cursor.jobs)) {
    if (!retained.has(id)) {
      delete cursor.jobs[id]
    }
  }

  const rows: string[] = []
  let remaining = 18000

  function add(value: unknown) {
    const row = JSON.stringify(value)

    if (row.length > remaining) {
      return false
    }

    rows.push(row)
    remaining -= row.length + 1
    return true
  }

  for (const { request, state, milestone } of jobs) {
    if (request.recurring?.audit) {
      continue
    }

    const observed = {
      id: request.id,
      kind: request.kind,
      task: request.task.slice(0, 350),
      status: state.status,
      updated: state.updatedAt,
      summary: state.summary?.slice(0, 900),
      error: state.error?.slice(0, 600),
      milestone: milestone?.slice(0, 400),
      health: state.health,
      stage: state.progress?.stage,
      progress: state.progress?.summary?.slice(0, 500),
      child: state.progress?.child && {
        role: state.progress.child.role,
        stage: state.progress.child.stage,
        tool: state.progress.child.tool,
        updated: state.progress.child.updatedAt,
      },
      lastActivity: state.progress?.updatedAt,
      checks: state.receipts?.slice(-8).map((r) => [r.check.slice(0, 120), r.status]),
    }
    const fingerprint = digest(JSON.stringify(observed))

    if (previous.jobs[request.id] !== fingerprint && add(observed)) {
      cursor.jobs[request.id] = fingerprint
    }
  }

  const last = previous.sessions[session]
  const start = last ? entries.findLastIndex((entry) => entry.id === last) + 1 : 0

  for (const turn of discussions(entries.slice(start))) {
    if (!add({ session, ...turn })) {
      break
    }

    cursor.sessions[session] = turn.id
  }

  return { cursor, context: rows.join('\n') }
}

export async function writeAuditReport(request: DelegationRequest, result: WorkerResult) {
  projectTraces(request.root, true)
  const directory = join(request.root, '.pi', 'audit')
  await mkdir(directory, { recursive: true, mode: 0o700 })

  if (!(await lstat(directory)).isDirectory()) {
    throw new Error('Audit output requires a real .pi/audit directory')
  }

  const relative = `.pi/audit/${request.id}.json`
  await atomicJson(join(directory, `${request.id}.json`), {
    schedule: request.recurring?.name,
    job: request.id,
    startedAt: request.createdAt,
    reportedAt: new Date().toISOString(),
    task: request.task,
    result,
  })
  return {
    auditReport: relative,
    auditAttention: Boolean(
      result.findings.length || result.hostActions?.length || result.verdict !== 'pass',
    ),
  }
}
