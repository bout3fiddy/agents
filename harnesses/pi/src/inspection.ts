import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
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
      children
        ?.filter(({ evidence }) =>
          ['reviewer', 'database-reviewer', 'performance'].includes(evidence.role),
        )
        .map(({ evidence: { role, model, snapshot, result } }) => ({
          role,
          model,
          snapshot,
          verdict: result.verdict,
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
  required: resultSchema.properties.findings,
  reason: Type.Optional(Type.String()),
  hostActions: resultSchema.properties.hostActions,
})

export function inspectionTools(pi: ExtensionAPI): void {
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
      'Read PR head, state, reviews, checks and their details or target URLs in one query.',
    parameters: Type.Object({
      repository: Type.String({ pattern: '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' }),
      number: Type.Integer({ minimum: 1 }),
    }),
    outputSchema: Type.Object(
      {
        headRefOid: Type.String(),
        state: Type.String(),
        number: Type.Integer(),
        isDraft: Type.Boolean(),
        mergeable: Type.String(),
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
    async execute(_call, { repository, number }, signal) {
      const fields =
        'number,state,isDraft,headRefOid,mergeable,reviewDecision,reviews,statusCheckRollup'
      const projection =
        '{number,state,isDraft,headRefOid,mergeable,reviewDecision,' +
        'reviews:[.reviews[]|{state,author:.author.login,commit:.commit.oid}],' +
        'statusCheckRollup:[.statusCheckRollup[]|' +
        '{name,context,status,state,conclusion,detailsUrl,targetUrl}]}'
      const value = JSON.parse(
        await githubCommand(
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
      )
      return { ...textResult(value), structuredContent: value }
    },
  })
}
