import {
  createCodemodeExtension,
  type CodemodeToolDetails,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'

export const workerInspectionTools = new Set([
  'project_read',
  'project_search',
  'original_read',
  'read_reference',
])

/** The host shell and file writes stay direct calls: each is the user's to see and approve. */
export const directOnly = new Set(['codemode', 'bash', 'write', 'edit'])

/**
 * Code mode: one script calls many tools, chains their results and returns only what matters.
 * `allowed` names the tools a script may call. For the host that is everything except the
 * shell and file writes; for a worker it is its read-only inspections.
 */
export function registerInspectionMode(
  pi: ExtensionAPI,
  allowed: ReadonlySet<string>,
  scope = 'Read-only inspection script.',
) {
  const scriptable = (tool: { name: string }) => allowed.has(tool.name)
  createCodemodeExtension({ models: false, mode: 'on' })({
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        promptSnippet: 'Batch, chain and filter tool calls in JavaScript',
        promptGuidelines: [
          'Prefer codemode whenever a step needs two or more tool calls, a search followed ' +
            'by reads, or a large result of which only part matters.',
        ],
        prepareLoadout(loadout) {
          const callable = loadout.callable.filter(scriptable)
          const prepared = tool.prepareLoadout?.({ ...loadout, callable })
          const names = callable.map((entry) => entry.name).join(', ')
          return {
            ...prepared,
            descriptions: {
              ...prepared?.descriptions,
              codemode:
                `${scope} Available tools: ${names || 'none'}.\n\n` +
                (prepared?.descriptions?.codemode ?? tool.description),
            },
          }
        },
        async execute(id, args, signal, update, ctx) {
          const executeTool: typeof ctx.executeTool = async (name, input, options) => {
            if (!allowed.has(name)) {
              throw new Error('Tool unavailable inside a script; call it directly: ' + name)
            }

            return ctx.executeTool(name, input, options)
          }
          const scriptContext = Object.create(ctx, {
            tools: { value: ctx.tools.filter(scriptable) },
            executeTool: { value: executeTool },
          })
          const result = await tool.execute(id, args, signal, update, scriptContext)
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

          return { ...result, content }
        },
      })
    },
  })
  pi.on('tool_call', (event) => {
    if (event.parentToolCallId && !allowed.has(event.toolName)) {
      return { block: true, reason: 'Call this tool directly, outside the script.' }
    }
  })
}
