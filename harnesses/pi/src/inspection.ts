import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { inspectCiRun } from './ci-timing.ts'
import { engineeringReviewSchema, testingScore } from './testing-assessment.ts'
import { githubPrState } from './github-pr-state.ts'
import { githubCommand } from './branch-github.ts'
import { receiptView } from './context.ts'
import { resultSchema, type Receipt, type WorkerEvidence } from './contracts.ts'
import {
  delegationDirectory,
  type DelegationRequest,
  type DelegationStatus,
} from './delegation-state.ts'
import { textResult } from './file-tools.ts'
import { readJson, StateStore } from './state.ts'
import { safeTrace } from './workers-data.ts'

export const nestedInspectionTools = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'project_read',
  'project_search',
  'task_status',
  'harness_status',
  'harness_capabilities',
  'project_memory_history',
  'review_receipts',
  'inspect_pr',
  'inspect_ci_run',
  'compare_candidates',
])

export async function reviewReceipts(store: StateStore, id: string) {
  const directory = delegationDirectory(store, id)
  const path = (name: string) => safeTrace(store, join(directory, name))
  const state = await readJson<DelegationStatus>(await path('status.json'))

  if (!state) {
    throw new Error('Unknown delegated task')
  }

  const attempt = state.progressFile ?? 'coordinator.json'

  if (!/^[a-zA-Z0-9-]+\.json$/.test(attempt)) {
    throw new Error('Invalid progress file')
  }

  const [children, provisional] = await Promise.all([
    path(attempt + '.children.json').then((p) => readJson<{ evidence: WorkerEvidence }[]>(p)),
    path(attempt + '.checks.json').then((p) => readJson<Receipt[]>(p)),
  ])
  let reviewed = children?.map((child) => child.evidence)

  if (!reviewed && state.workflowTaskId && state.receiptAttempt === attempt) {
    if (!/^[a-f0-9-]{36}$/.test(state.workflowTaskId)) {
      throw new Error('Invalid workflow task ID')
    }

    const task = await readJson<{ evidence: WorkerEvidence[] }>(
      await safeTrace(store, join(store.directory, 'tasks', state.workflowTaskId + '.json')),
    )
    reviewed = task?.evidence
  }

  let checks = provisional

  if (state.receipts && state.receiptAttempt === attempt) {
    checks = state.receipts
  } else if (state.receipts && !state.receiptAttempt) {

    // Local tasks clear receipts on every resume. Older branch repair attempts could retain them.
    const request = await readJson<DelegationRequest>(await path('request.json'))

    if (request && request.kind !== 'branch') {
      checks = state.receipts
    }
  }

  return {
    id,
    attempt,
    state: state.status,
    status: state.status,
    reviews:
      reviewed
        ?.filter(
          ({ role, result }) =>
            role === 'performance' ||
            role === 'reviewer' ||
            role === 'database-reviewer' ||
            Boolean(result.engineeringReview),
        )
        .map(({ role, model, snapshot, result, closedReview }) => ({
          role,
          model,
          snapshot,
          verdict: result.verdict,
          ...(closedReview && { reviewedSnapshot: closedReview.snapshot }),
          ...(result.engineeringReview && {
            engineeringReview: result.engineeringReview,
            testingScore: testingScore(result.engineeringReview),
          }),
          required: result.findings.filter((f) => f.severity === 'required'),
          ...(result.verdict === 'blocked' && { reason: result.summary }),
          hostActions: result.hostActions ?? [],
        })) ?? null,
    checks:
      checks?.map((r) =>
        r.status === 'passed'
          ? { check: r.check, snapshot: r.snapshot, status: r.status }
          : receiptView(r),
      ) ?? null,
  }
}

const nullableString = Type.Union([Type.String(), Type.Null()])

const reviewSchema = Type.Object({
  role: Type.String(),
  model: Type.String(),
  snapshot: Type.String(),
  verdict: resultSchema.properties.verdict,
  reviewedSnapshot: Type.Optional(Type.String()),
  engineeringReview: Type.Optional(engineeringReviewSchema),
  testingScore: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  required: resultSchema.properties.findings,
  reason: Type.Optional(Type.String()),
  hostActions: resultSchema.properties.hostActions,
})

export function inspectionTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'inspect_ci_run',
    label: 'Inspect CI timings',
    description:
      'Measure Actions attempt wall time, job start delays, slow steps, last finisher ' +
      'and other runs of the same workflow on this head. Batch comparable runs in codemode.',
    parameters: Type.Object({
      repository: Type.String({ pattern: '^[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$' }),
      runId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    outputSchema: Type.Object(
      {
        runId: Type.Integer(),
        head: Type.String(),
        attempt: Type.Integer(),
        wallMs: Type.Union([Type.Integer(), Type.Null()]),
        longestJobs: Type.Array(Type.Object({}, { additionalProperties: true })),
        sameHeadRuns: Type.Array(Type.Object({}, { additionalProperties: true })),
      },
      { additionalProperties: true },
    ),
    async execute(_id, { repository, runId }, signal) {
      const value = await inspectCiRun(repository, runId, signal)
      return { ...textResult(value), structuredContent: value }
    },
  })
  pi.registerTool({
    name: 'review_receipts',
    label: 'Inspect review receipts',
    description:
      'Inspect the current attempt, verdicts, required findings and checks. Null means missing.',
    parameters: Type.Object({ id: Type.String() }),
    outputSchema: Type.Object({
      id: Type.String(),
      attempt: Type.String(),
      state: Type.String(),
      status: Type.String(),
      reviews: Type.Union([Type.Array(reviewSchema), Type.Null()]),
      checks: Type.Union([
        Type.Array(
          Type.Object(
            {
              check: Type.String(),
              inheritedLintPaths: Type.Optional(Type.Array(Type.String())),
              snapshot: Type.String(),
              status: Type.String(),
            },
            { additionalProperties: true },
          ),
        ),
        Type.Null(),
      ]),
    }),
    async execute(_call, { id }, _signal, _update, ctx) {
      const value = await reviewReceipts(new StateStore(ctx.cwd), id)
      return { ...textResult(value), structuredContent: value }
    },
  })
  pi.registerTool({
    name: 'inspect_pr',
    label: 'Inspect pull request',
    description:
      'Read PR commits, reviews and checks. Set includeQueue to verify GitHub queue membership.',
    parameters: Type.Object({
      repository: Type.String({ pattern: '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' }),
      number: Type.Integer({ minimum: 1 }),
      includeQueue: Type.Optional(Type.Boolean()),
    }),
    outputSchema: Type.Object(
      {
        baseRefName: Type.String(),
        baseRefOid: Type.String(),
        headRefOid: Type.String(),
        state: Type.String(),
        number: Type.Integer(),
        isDraft: Type.Boolean(),
        mergeable: Type.String(),
        isInMergeQueue: Type.Optional(Type.Boolean()),
        mergeStateStatus: Type.Optional(Type.String()),
        reviewDecision: nullableString,
        statusCheckRollup: Type.Array(
          Type.Object({
            name: nullableString,
            context: nullableString,
            status: nullableString,
            state: nullableString,
            conclusion: nullableString,
            detailsUrl: nullableString,
            targetUrl: nullableString,
          }),
        ),
        reviews: Type.Array(
          Type.Object({
            state: nullableString,
            author: nullableString,
            commit: nullableString,
          }),
        ),
      },
      { additionalProperties: true },
    ),
    async execute(_call, { repository, number, includeQueue }, signal) {
      const fields =
        'number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeable,' +
        'reviewDecision,reviews,statusCheckRollup'
      const projection =
        '{number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeable,reviewDecision,' +
        'reviews:[.reviews[]|{state,author:.author.login,commit:.commit.oid}],' +
        'statusCheckRollup:[.statusCheckRollup[]|' +
        '{name,context,status,state,conclusion,detailsUrl,targetUrl}]}'
      const [raw, queue] = await Promise.all([
        githubCommand(
          [
            'pr',
            'view',
            String(number),
            '--repo',
            repository,
            '--json',
            fields,
            '--jq',
            projection,
          ],
          signal,
        ),
        includeQueue ? githubPrState(repository, number, signal) : undefined,
      ])
      const value = JSON.parse(raw)

      if (queue) {
        if (queue.headRefOid !== value.headRefOid || queue.state !== value.state) {
          throw new Error('PR changed during inspection; refresh its checks and queue state')
        }

        value.isInMergeQueue = queue.isInMergeQueue
        value.mergeStateStatus = queue.mergeStateStatus
      }

      return { ...textResult(value), structuredContent: value }
    },
  })
}
