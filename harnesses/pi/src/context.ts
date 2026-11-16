import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Checkpoint, Receipt } from './contracts.ts'
import type { TaskState } from './state.ts'

export function receiptView(receipt: Receipt) {
  const limit = receipt.status === 'passed' ? 2000 : 4000
  return {
    check: receipt.check,
    status: receipt.status,
    snapshot: receipt.snapshot,
    argv: receipt.result.argv,
    exitCode: receipt.result.exitCode,
    output: receipt.result.output.slice(-limit),
    outputExcerpted: receipt.result.output.length > limit,
    timedOut: receipt.result.timedOut,
    aborted: receipt.result.aborted,
    truncated: receipt.result.truncated,
  }
}

export function taskView(task: TaskState) {
  const latest = new Map(task.evidence.map((item) => [item.role, item]))
  return {
    id: task.id,
    status: task.status,
    phase: task.phase,
    round: task.round,
    error: task.error,
    candidate: task.candidate,
    resumedFrom: task.resumedFrom,
    roles: [...latest.values()].map((item) => ({
      role: item.role,
      model: item.model,
      verdict: item.result.verdict,
      summary: item.result.summary,
      requiredFindings: item.result.findings
        .filter((finding) => finding.severity === 'required')
        .map((finding) => ({ location: finding.location, problem: finding.problem.slice(0, 500) })),
    })),
    checks: task.receipts.map((item) => ({
      check: item.check,
      status: item.status,
      snapshot: item.snapshot,
    })),
  }
}

export function checkpointText(checkpoint: Checkpoint, task?: TaskState): string {
  if (
    task?.designHash !== checkpoint.hash ||
    (task.designVersion !== undefined && task.designVersion !== checkpoint.version)
  ) {
    task = undefined
  }

  return JSON.stringify({
    piCheckpointHash: checkpoint.hash,
    acceptedDesign: checkpoint,
    work: task && {
      id: task.id,
      status: task.status,
      phase: task.phase,
      error: task.error,
      summary: task.evidence.at(-1)?.result.summary,
      receipts: task.receipts.map((item) => ({
        check: item.check,
        status: item.status,
        snapshot: item.snapshot,
      })),
    },
  })
}

export function projectContext(messages: AgentMessage[], checkpoint?: Checkpoint): AgentMessage[] {
  if (!checkpoint) {
    return messages
  }

  const accepted = Date.parse(checkpoint.acceptedAt)

  return messages.filter((message) => {
    if (message.role === 'system') {
      return true
    }

    // Upstream branch/compaction summaries can contain old exploration. Rebuild from owned state.
    if (!['user', 'assistant', 'toolResult'].includes(message.role)) {
      return false
    }

    return (
      'timestamp' in message &&
      typeof message.timestamp === 'number' &&
      message.timestamp >= accepted
    )
  })
}
