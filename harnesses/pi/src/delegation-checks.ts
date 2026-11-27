import { extname } from 'node:path'
import { checkDocuments } from './document-tools.ts'
import { changes } from './integration.ts'
import { digest, snapshotHash, writable, rejectIgnoredAdditions } from './paths.ts'
import { verifyProject } from './project.ts'
import { benchmarks, databaseImpact } from './workflow.ts'
import { completedResult, validateResult, type Project, type Receipt } from './contracts.ts'
import {
  documentReceiptLimits,
  type DelegationRequest,
  type DocumentReceipt,
} from './delegation-state.ts'
import { invariant } from './invariant.ts'
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

/** What the Markdown check observed on a candidate, kept for the task's delivery receipt. */
export type DocumentChecks = { checked: string[]; formattingSkipped: string[] }

/**
 * The receipt for a documents candidate that passed checkDelegation and was applied to root.
 * It restates what was checked and names the applied content; it checks nothing itself.
 */
export function documentReceipt(
  root: string,
  changed: string[],
  after: Map<string, Buffer>,
  observed: DocumentChecks,
  now: Date,
): DocumentReceipt {
  invariant(changed.length > 0, 'a delivery receipt names at least one changed path')
  const applied = changed.filter((path) => after.has(path)).sort()
  const removed = changed.filter((path) => !after.has(path)).sort()
  const hashes = applied.map((path) => [path, digest(after.get(path)!)] as const)
  const listed = hashes.slice(0, documentReceiptLimits.files)
  const words = (path: string) => after.get(path)!.toString('utf8').split(/\s+/).filter(Boolean)
  return {
    checkout: root,
    revision: digest(JSON.stringify([hashes, removed])),
    appliedAt: now.toISOString(),
    files: listed.map(([path, sha256]) => ({ path, sha256, words: words(path).length })),
    ...(hashes.length > listed.length && { more: hashes.length - listed.length }),
    ...(removed.length && { removed: removed.slice(0, documentReceiptLimits.files) }),
    checks: [
      'every changed path is inside the write scope and is a document',
      `Markdown format and 100-column width passed on ${observed.checked.length} file(s)`,
      'applied to the checkout without a concurrent edit',
    ],
    ...(observed.formattingSkipped.length && {
      formattingSkipped: observed.formattingSkipped.slice(0, documentReceiptLimits.files),
    }),
  }
}

export async function checkDelegation(
  request: DelegationRequest,
  workspace: string,
  project: Project,
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  evidence: TaskCoordinatorEvidence,
  signal: AbortSignal,
  documents?: DocumentChecks,
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

    documents?.checked.push(...checked.checked)
    documents?.formattingSkipped.push(...checked.formattingSkipped)
  }

  if (request.branch?.design.performanceReview ?? request.performanceReview) {
    const review = evidence.children.findLast((child) => child.role === 'performance')

    if (
      !review ||
      !completedResult(review.result.verdict, request.kind === 'research') ||
      review.snapshot !== snapshotHash(after)
    ) {
      throw new DelegationRepairRequired(
        'Task requires the requested performance evidence on the final snapshot',
      )
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

  const performance =
    request.branch?.design.performance ||
    evidence.children.some((child) => child.role === 'performance')

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
