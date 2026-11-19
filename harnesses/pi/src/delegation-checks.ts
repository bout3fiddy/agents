import { extname } from 'node:path'
import { checkDocuments } from './document-tools.ts'
import { changes } from './integration.ts'
import { snapshotHash, writable, rejectIgnoredAdditions } from './paths.ts'
import { verifyProject } from './project.ts'
import { benchmarks, databaseImpact } from './workflow.ts'
import { completedResult, validateResult, type Project, type Receipt } from './contracts.ts'
import type { DelegationRequest } from './delegation-state.ts'
import type { TaskCoordinatorEvidence } from './task-coordinator.ts'

export class DelegationChecksFailed extends Error {
  constructor(
    readonly receipts: Receipt[],
    failed: Receipt[],
  ) {
    super(`Required checks failed: ${failed.map((receipt) => receipt.check).join(', ')}`)
  }
}

export class DelegationRepairRequired extends Error {}

export async function checkDelegation(
  request: DelegationRequest,
  workspace: string,
  project: Project,
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  evidence: TaskCoordinatorEvidence,
  signal: AbortSignal,
): Promise<Receipt[]> {
  const audit = request.kind === 'research' && request.recurring?.audit
  validateResult(evidence.result, Boolean(audit && request.recurring?.stopWhen))

  // Read-only audit findings and blockers go into the report after scope verification.
  if (!audit && !completedResult(evidence.result.verdict, request.kind === 'research')) {
    throw new Error(`Coordinator reported ${evidence.result.verdict}: ${evidence.result.summary}`)
  }

  const changed = changes(before, after)
  await rejectIgnoredAdditions(request.root, before, after)

  for (const path of changed) {
    if (!writable(path, request.writePaths)) {
      throw new Error(`Task changed a path outside its assignment: ${path}`)
    }

    if (request.kind === 'documents' && !['.md', '.txt', '.rst'].includes(extname(path))) {
      throw new Error(`Document task changed a non-document: ${path}`)
    }
  }

  const markdown = changed.filter((path) => path.endsWith('.md') && after.has(path))

  for (let offset = 0; offset < markdown.length; offset += 24) {
    const checked = await checkDocuments(workspace, markdown.slice(offset, offset + 24), false)

    if (checked.status !== 'passed') {
      throw new DelegationRepairRequired(checked.failures.join('\n'))
    }
  }

  if ((!changed.length && request.kind !== 'branch') || request.kind === 'documents') {
    return []
  }

  const database =
    request.branch?.design.database ||
    evidence.result.databaseImpact ||
    evidence.children.some((child) => child.result.databaseImpact) ||
    databaseImpact(before, after, project.databasePaths)
  const snapshot = snapshotHash(after)

  const performance =
    request.branch?.design.performance ||
    evidence.children.some((child) => child.role === 'performance')

  for (const role of [
    ...(request.review === false && request.kind !== 'branch' ? [] : ['reviewer']),
    ...(database ? ['database-reviewer'] : []),
    ...(performance ? ['performance'] : []),
  ]) {
    const review = evidence.children.findLast((child) => child.role === role)

    if (!review || review.result.verdict !== 'pass' || review.snapshot !== snapshot) {
      throw new DelegationRepairRequired(
        `Changed code requires a passing ${role} on the final snapshot`,
      )
    }
  }

  const receipts = await verifyProject(workspace, project, database, signal, {
    files: before,
    writePaths: request.writePaths,
  })

  if (performance) {
    receipts.push(...(await benchmarks(workspace, project, signal)))
  }

  const failed = receipts.filter(
    (receipt) =>
      receipt.status !== 'passed' &&
      (receipt.check === 'harness-lint' ||
        receipt.check.startsWith('required-') ||
        project.checks.find((check) => check.id === receipt.check)?.required),
  )

  if (failed.length) {
    throw new DelegationChecksFailed(receipts, failed)
  }

  return receipts
}
