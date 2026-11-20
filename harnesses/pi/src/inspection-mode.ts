import {
  createCodemodeExtension,
  type CodemodeToolDetails,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import type { reviewReceipts } from './inspection.ts'

export const workerInspectionTools = new Set([
  'project_read',
  'project_search',
  'original_read',
  'read_reference',
])

export function registerInspectionMode(pi: ExtensionAPI, allowed: ReadonlySet<string>) {
  const inspectable = (tool: { name: string }) => allowed.has(tool.name)
  createCodemodeExtension({ models: false, mode: 'on' })({
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        promptSnippet: 'Batch or chain read-only inspections in JavaScript',
        promptGuidelines: [
          'Use codemode for independent reads, search followed by reads, or filtering a large ' +
            'inspection result before it enters the conversation. ' +
            'Issue commands, checks and edits as direct tool calls.',
        ],
        prepareLoadout(loadout) {
          const callable = loadout.callable.filter(inspectable)
          const prepared = tool.prepareLoadout?.({
            ...loadout,
            callable,
          })
          const names = callable.map((entry) => entry.name).join(', ')
          const scope = 'Read-only inspection script. Available tools: ' + (names || 'none') + '.'
          return {
            ...prepared,
            descriptions: {
              ...prepared?.descriptions,
              codemode:
                scope +
                ' Call shell commands, tests, edits and delegation directly.\n\n' +
                (prepared?.descriptions?.codemode ?? tool.description),
            },
          }
        },
        async execute(id, args, signal, update, ctx) {
          const checkEvidence = new Set<string>()
          const executeTool: typeof ctx.executeTool = async (name, input, options) => {
            if (!allowed.has(name)) {
              throw new Error('Tool unavailable inside this inspection script: ' + name)
            }

            const outcome = await ctx.executeTool(name, input, options)

            if (name === 'review_receipts' && !outcome.isError) {
              const receipt = outcome.result.structuredContent as
                Awaited<ReturnType<typeof reviewReceipts>> | undefined

              for (const review of receipt?.reviews ?? []) {
                for (const finding of review.required) {
                  checkEvidence.add(
                    JSON.stringify({
                      id: receipt!.id,
                      snapshot: review.snapshot,
                      role: review.role,
                      severity: 'required',
                      location: finding.location,
                      problem: finding.problem,
                    }),
                  )
                }
              }

              if (receipt && receipt.checks === null) {
                checkEvidence.add(
                  JSON.stringify({ id: receipt.id, attempt: receipt.attempt, checks: null }),
                )
              }

              for (const check of receipt?.checks ?? []) {
                if (check.status !== 'passed') {
                  checkEvidence.add(
                    JSON.stringify({
                      id: receipt!.id,
                      attempt: receipt!.attempt,
                      check: check.check,
                      status: check.status,
                      snapshot: check.snapshot,
                    }),
                  )
                }
              }
            }

            return outcome
          }
          const inspectionContext = Object.create(ctx, {
            tools: { value: ctx.tools.filter(inspectable) },
            executeTool: { value: executeTool },
          })
          const result = await tool.execute(id, args, signal, update, inspectionContext)

          const details = result.details as CodemodeToolDetails | undefined
          let content = result.content

          if (details?.fullOutputPath && !allowed.has('read')) {
            const hint =
              '\n\n[Full output: ' + details.fullOutputPath + ' (read with offset/limit)]'
            content = content.map((block) => {
              if (block.type !== 'text' || !block.text.endsWith(hint)) {
                return block
              }

              return {
                ...block,
                text:
                  block.text.slice(0, -hint.length) +
                  '\n\nUse load(key) for values saved with store(). Otherwise rerun the ' +
                  'relevant scoped read with a smaller range or narrower output.',
              }
            })
          }

          const failures =
            details?.calls.filter(
              (call) => call.status === 'error' || call.status === 'cancelled',
            ) ?? []

          if (failures.length) {
            const lines = failures
              .slice(0, 6)
              .map((call) =>
                [call.name, call.args.slice(0, 240), call.status, call.error?.slice(0, 240)]
                  .filter(Boolean)
                  .join(' '),
              )
            content = [
              ...content,
              {
                type: 'text' as const,
                text:
                  'Failed or cancelled nested calls (' +
                  failures.length +
                  ' total, showing ' +
                  lines.length +
                  '):\n' +
                  lines.join('\n'),
              },
            ]
          }

          if (checkEvidence.size) {
            content = [
              ...content,
              {
                type: 'text' as const,
                text: 'Recorded review and check evidence:\n' + [...checkEvidence].join('\n'),
              },
            ]
          }

          return { ...result, content }
        },
      })
    },
  })
  pi.on('tool_call', (event) => {
    if (event.parentToolCallId && !allowed.has(event.toolName)) {
      return { block: true, reason: 'Use a direct role-authorized call for this tool.' }
    }
  })
}
