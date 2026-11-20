import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Check, Errors } from 'typebox/value'
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

const role = await loadRole(request.role, request.thinking, request.implementerModel)
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

    if (!tool) {
      throw new Error('Unknown scoped worker tool. Select an advertised tool for this role.')
    }

    const args = call.params.arguments ?? {}

    if (!Check(tool.parameters, args)) {
      const problems = Errors(tool.parameters, args).slice(0, 3)
      const reason = problems
        .map((error) => {
          return `${error.instancePath || '/'} ${error.message}`
        })
        .join('; ')
      throw new Error(`Invalid ${tool.name} arguments: ${reason}. The tool did not run.`)
    }

    const invoke = () =>
      tool.execute(String(++calls), args, context.signal, undefined, {} as ExtensionToolContext)
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

    await atomicJson(`${process.argv[3] ?? request.outputPath}.tools.json`, {
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
