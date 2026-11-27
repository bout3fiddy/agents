import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { inspectCiRun } from './ci-timing.ts'
import { githubPrState } from './github-pr-state.ts'
import { githubCommand } from './branch-github.ts'
import { textResult } from './file-tools.ts'

const nullableString = Type.Union([Type.String(), Type.Null()])

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
