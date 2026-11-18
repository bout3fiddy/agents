import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Check } from 'typebox/value'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { WorkerRequest } from './contracts.ts'
import { atomicJson, readJson } from './state.ts'
import { loadRole } from './roles.ts'
import { createWorkerTools } from './worker-tools.ts'
import { WorkerMailbox, guidanceText } from './worker-mailbox.ts'
import { workerDirectory } from './worker-live.ts'

const request = await readJson<WorkerRequest>(process.argv[2]!)

if (!request) {
  throw new Error('Missing Claude tool assignment')
}

const role = await loadRole(request.role)
const worker = createWorkerTools(request, role)
const mailbox = request.liveWorkerId
  ? new WorkerMailbox(workerDirectory(request.project.root, request.liveWorkerId))
  : undefined
const server = new Server(
  { name: 'pi-worker-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
)
let calls = 0
let queue: Promise<unknown> = Promise.resolve()
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: worker.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
  })),
}))
server.setRequestHandler(CallToolRequestSchema, async (call, context) => {
  const action = queue.then(async () => {
    if (worker.result()) {
      throw new Error('This worker has already submitted its final result')
    }

    const tool = worker.tools.find((item) => item.name === call.params.name)

    if (!tool || !Check(tool.parameters, call.params.arguments ?? {})) {
      throw new Error('Unknown or invalid scoped worker tool call')
    }

    const invoke = () =>
      tool.execute(
        String(++calls),
        call.params.arguments ?? {},
        context.signal,
        undefined,
        {} as ExtensionToolContext,
      )
    const boundary = mailbox
      ? await mailbox.toolBoundary(tool.name === 'submit_result', invoke)
      : { blocked: false as const, messages: [], result: await invoke() }
    const guidance = boundary.messages.map((message) => ({
      type: 'text' as const,
      text: guidanceText(message),
    }))

    if (boundary.blocked) {
      return {
        isError: true,
        content: [
          ...guidance,
          {
            type: 'text',
            text: 'New user guidance arrived. Address it before retrying this tool or submitting.',
          },
        ],
      }
    }

    await atomicJson(`${request.outputPath}.tools.json`, {
      commands: worker.commands,
      result: worker.result(),
      calls,
    })
    return { ...boundary.result, content: [...guidance, ...boundary.result.content] }
  })
  queue = action.catch(() => {})

  try {
    return await action
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    }
  }
})
await server.connect(new StdioServerTransport())
