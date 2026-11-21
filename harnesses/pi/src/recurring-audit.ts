import { existsSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Delegation, DelegationRequest } from './delegation-state.ts'
import type { WorkerResult } from './contracts.ts'
import { digest } from './paths.ts'
import { atomicJson, atomicText } from './state.ts'
import { gitCommand } from './git-branches.ts'
import { projectTraces } from './traces.ts'

export const reportDirectorySchema = Type.String({
  maxLength: 160,
  pattern: '^\\.pi/audits?(?:/[a-z0-9][a-z0-9_-]{0,63}){0,2}/?$',
  description: 'Private Markdown report folder, e.g. .pi/audits/progress.',
})

export type AuditCursor = {
  currentBaseline?: true
  head?: string
  sessions: Record<string, string>
  jobs: Record<string, string>
}
export const emptyCursor = (): AuditCursor => ({ sessions: {}, jobs: {} })

type Branch = ReturnType<ExtensionContext['sessionManager']['getBranch']>

function discussions(entries: Branch, taskIds: Set<string>) {
  const turns: { id: string; at: string; user?: string; trigger?: string; answer: string }[] = []
  let origin: { user?: string; trigger?: string } | undefined

  for (const entry of entries) {
    if (entry.type === 'custom_message' && entry.customType === 'pi-task-result') {
      const details = entry.details as { taskIds?: unknown } | undefined

      if (
        Array.isArray(details?.taskIds) &&
        details.taskIds.some((id) => typeof id === 'string' && taskIds.has(id.split(':')[0]!))
      ) {
        origin ??= { trigger: 'background task outcome' }
      }
    }

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
      origin = { user: text.slice(0, 1000) }
    }

    if (origin && message.role === 'assistant' && message.stopReason === 'stop') {
      turns.push({
        id: entry.id,
        at: entry.timestamp,
        ...origin,
        answer: message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .slice(0, 1400),
      })
      origin = undefined
    }
  }

  return turns
}

/** Keep the host's reported outcome separate from the head observed at the next dispatch. */
function latestAuditFollowup(entries: Branch, jobs: Delegation[]) {
  const auditIds = new Set(
    jobs.filter((job) => job.request.recurring?.audit).map((job) => job.request.id),
  )
  let auditWake = false
  let shellCompleted = false
  let latest: { id: string; hostReport: string } | undefined

  for (const entry of entries) {
    if (entry.type === 'custom_message' && entry.customType === 'pi-task-result') {
      const ids = (entry.details as { taskIds?: unknown } | undefined)?.taskIds
      auditWake =
        Array.isArray(ids) &&
        ids.some((id) => typeof id === 'string' && auditIds.has(id.split(':')[0]!))
      shellCompleted = false
    }

    if (!auditWake || entry.type !== 'message') {
      continue
    }

    const message = entry.message

    if (message.role === 'user') {
      auditWake = false
    } else if (message.role === 'toolResult' && message.toolName === 'bash' && !message.isError) {
      shellCompleted = true
    } else if (message.role === 'assistant' && message.stopReason === 'stop') {
      const hostReport = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
        .slice(0, 1400)

      if (shellCompleted && hostReport) {
        latest = { id: entry.id, hostReport }
      }

      auditWake = false
    }
  }

  return latest
}

export async function auditHead(root: string) {
  if (!existsSync(join(root, '.git'))) {
    return undefined
  }

  return gitCommand(root, ['rev-parse', '--verify', 'HEAD']).catch(() => undefined)
}

export function auditDelta(
  previous: AuditCursor,
  session: string,
  entries: Branch,
  jobs: Delegation[],
  head?: string,
) {
  const cursor = structuredClone(previous)
  const retained = new Set(jobs.map((job) => job.request.id))

  for (const id of Object.keys(cursor.jobs)) {
    if (!retained.has(id)) {
      delete cursor.jobs[id]
    }
  }

  const rows: string[] = []
  const followup = latestAuditFollowup(entries, jobs)
  const reference = JSON.stringify({ head, latestAuditFollowup: followup })
  let remaining = 18000 - reference.length - 1

  function add(value: unknown) {
    const row = JSON.stringify(value)

    if (row.length > remaining) {
      return false
    }

    rows.push(row)
    remaining -= row.length + 1
    return true
  }

  if (head && previous.head !== head) {
    add({ head, previousHead: previous.head })
    cursor.head = head
  }

  // Keep host verification and integration outcomes ahead of verbose worker status.
  const taskIds = new Set(
    jobs.filter((job) => !job.request.recurring?.audit).map((job) => job.request.id),
  )
  const last = previous.sessions[session]
  const index = last ? entries.findLastIndex((entry) => entry.id === last) : -1
  const baseline = !previous.currentBaseline || Boolean(last && index < 0)
  cursor.currentBaseline = true
  const turns = discussions(entries.slice(index + 1), taskIds)
  const latest = turns.at(-1)

  // A first report summarizes the current project. Reserve space for current worker receipts.
  const jobBudget = Math.floor(remaining / 2)
  remaining -= jobBudget

  for (const turn of baseline ? turns.slice(-3).reverse() : turns) {
    if (!add({ session, ...turn })) {
      break
    }

    cursor.sessions[session] = turn.id
  }

  if (baseline && latest) {
    cursor.sessions[session] = latest.id
  }

  remaining += jobBudget
  const recent = jobs
    .filter((job) => !job.request.recurring?.audit)
    .toSorted((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt))

  for (const { request, state, milestone } of recent) {
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

    if (previous.jobs[request.id] !== fingerprint && (add(observed) || baseline)) {
      cursor.jobs[request.id] = fingerprint
    }
  }

  if (rows.length && (head || followup)) {
    rows.unshift(reference)
  }

  return { cursor, context: rows.join('\n') }
}

export async function writeAuditReport(
  request: DelegationRequest,
  result: WorkerResult,
  model?: string,
  thinking?: string,
) {
  const target = request.recurring?.reportDirectory

  if (target !== undefined && !Check(reportDirectorySchema, target)) {
    throw new Error('Invalid private audit report directory')
  }

  projectTraces(request.root, true)
  const folder = target?.replace(/\/$/, '') ?? '.pi/audit'
  let directory = join(request.root, '.pi')

  for (const part of folder.split('/').slice(1)) {
    directory = join(directory, part)
    await mkdir(directory, { recursive: true, mode: 0o700 })

    if (!(await lstat(directory)).isDirectory()) {
      throw new Error('Audit output requires a real ' + folder + ' directory')
    }
  }

  const reportedAt = new Date().toISOString()
  const stamp = new Date(request.createdAt).toISOString().replaceAll(':', '-')
  const relative = target
    ? folder + '/' + stamp + '-' + request.id + '.md'
    : folder + '/' + request.id + '.json'

  if (target) {
    const lines = [
      '# ' + request.recurring!.name + ' · ' + reportedAt,
      '',
      result.summary,
      ...result.findings.flatMap((f) => [
        '',
        '- ' + f.location + ' — ' + f.problem,
        '  ' + f.evidence,
      ]),
      ...(result.evidence.length
        ? ['', '## Evidence', '', ...result.evidence.map((e) => '- ' + e)]
        : []),
      ...(result.continuation
        ? ['', '## Next audit', '', result.continuation.action + ' — ' + result.continuation.reason]
        : []),
      '',
      'Job ' + request.id + (model ? ' · ' + model : '') + (thinking ? ' · ' + thinking : ''),
      '',
    ]
    await atomicText(join(request.root, relative), lines.join('\n'))
  } else {
    await atomicJson(join(request.root, relative), {
      schedule: request.recurring?.name,
      job: request.id,
      startedAt: request.createdAt,
      reportedAt,
      model,
      thinking,
      task: request.task,
      result,
    })
  }

  const required = result.findings.filter((finding) => finding.severity === 'required')
  return {
    auditReport: relative,
    ...(required.length && {
      auditRequired: required.slice(0, 3).map(({ location, problem }) => ({ location, problem })),
    }),
    auditDecision: result.continuation,
    auditAttention: Boolean(
      result.continuation?.action === 'stop' ||
      result.findings.length ||
      result.hostActions?.length ||
      result.verdict !== 'pass',
    ),
  }
}
