import type { Checkpoint, Receipt, WorkerEvidence } from './contracts.ts'
import { testingScore } from './testing-assessment.ts'
import type { TaskState } from './state.ts'

export function receiptView(receipt: Receipt) {
  const limit = receipt.status === 'passed' ? 2000 : 4000
  const { output } = receipt.result
  const tsxIpcDenied =
    receipt.status === 'failed' &&
    /^> tsx --test(?:\s|$)/m.test(output) &&
    /Error: listen EPERM:[^\n]*\/pi-command-[^/\s]+\/tsx-\d+\/\d+\.pipe\b/.test(output)
  return {
    ...(tsxIpcDenied && {
      diagnostic:
        'The tsx test launcher was denied a private IPC socket. ' +
        'The host can diagnose the declared check or configure the project to use ' +
        'node --import tsx --test with equivalent test selection and rerun the gate.',
    }),
    ...(receipt.inheritedLintPaths?.length && { inheritedLintPaths: receipt.inheritedLintPaths }),
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

export function childSummary(child: WorkerEvidence) {
  return {
    role: child.role,
    model: child.model,
    verdict: child.result.verdict,
    ...(child.result.engineeringReview && {
      snapshot: child.snapshot,
      testingScore: testingScore(child.result.engineeringReview),
    }),
    ...(child.closedReview && { closedReview: child.closedReview }),
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
      ...childSummary(item),
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
    implementationScope: checkpoint,
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
