import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Check } from 'typebox/value'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { WorkerRequest } from './contracts.ts'
import { atomicJson, readJson } from './state.ts'
import { loadRole } from './roles.ts'
import { createWorkerTools } from './worker-tools.ts'

const request = await readJson<WorkerRequest>(process.argv[2]!)

if (!request) {
  throw new Error('Missing Claude tool assignment')
}

const role = await loadRole(request.role)
const worker = createWorkerTools(request, role)
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
    if (++calls > role.maxTurns * 10) {
      throw new Error('Worker tool-call budget exhausted')
    }

    if (worker.result()) {
      throw new Error('This worker has already submitted its final result')
    }

    const tool = worker.tools.find((item) => item.name === call.params.name)

    if (!tool || !Check(tool.parameters, call.params.arguments ?? {})) {
      throw new Error('Unknown or invalid scoped worker tool call')
    }

    const result = await tool.execute(
      String(calls),
      call.params.arguments ?? {},
      context.signal,
      undefined,
      {} as ExtensionToolContext,
    )
    await atomicJson(`${request.outputPath}.tools.json`, {
      commands: worker.commands,
      result: worker.result(),
      calls,
    })
    return { content: result.content }
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
