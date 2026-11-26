import { appendFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StateStore, atomicJson } from './state.ts'
import { WorkerMailbox } from './worker-mailbox.ts'
import { inspectionTarget } from './workers-transcript.ts'

import type { ModelRoute } from './contracts.ts'

export type LiveWorkerInfo = Partial<ModelRoute> & {
  id: string
  taskId?: string
  parentId?: string
  reviewOf?: string
  role: string
  model: string
  thinking?: string
  task: string
  scope: string[]
  writeLimits?: string[]
  output: string
  workspace: string
  projectRoot: string
  pid: number
  startedAt: string
  backend: 'pi' | 'claude'
}
export type LiveWorkerState = {
  status: 'running' | 'complete' | 'needs_attention' | 'failed' | 'cancelled'
  updatedAt: string
  stage: string
  tool?: string
  summary?: string
  partial?: string
}
export type InspectionCall = {
  id?: string
  name: string
  path?: string
  line?: number
  column?: number
  target?: string
  status?: string
  error?: string
}

type CallMetadata = {
  toolCallId?: string
  parentToolCallId?: string
  isError?: boolean
  inspectionCalls?: InspectionCall[]
}
export type ConversationEntry = CallMetadata & { at: string; role: string; text: string }

export function callIdentity(event: object): CallMetadata {
  return {
    toolCallId:
      'toolCallId' in event && typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
    parentToolCallId:
      'parentToolCallId' in event && typeof event.parentToolCallId === 'string'
        ? event.parentToolCallId
        : undefined,
  }
}

export function workerDirectory(root: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) {
    throw new Error('Invalid live worker ID')
  }

  return join(new StateStore(root).directory, 'workers', id)
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) {
    return ''
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .map((part) => {
      if (part.type === 'text' || part.type === 'output_text') {
        return String(part.text ?? '')
      }

      if (part.type === 'toolCall' || part.type === 'tool_use') {
        return `${part.name} ${JSON.stringify(part.arguments ?? part.input ?? {})}`
      }

      if (part.type === 'tool_result') {
        return typeof part.content === 'string'
          ? part.content
          : messageText({ content: part.content })
      }

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// Project just the receipt fields needed by the viewer. SDK details may also contain full output.
function inspectionCalls(details: unknown): InspectionCall[] | undefined {
  if (
    !details ||
    typeof details !== 'object' ||
    !('calls' in details) ||
    !Array.isArray(details.calls)
  ) {
    return undefined
  }

  return details.calls.map((call) => {
    let args

    try {
      args = JSON.parse(call?.args)
    } catch {
      // Truncated arguments still count as an activity, not a known file.
    }

    return {
      ...inspectionTarget(typeof call?.name === 'string' ? call.name : '', args),
      id: typeof call?.id === 'string' ? call.id : undefined,
      status: call?.status === 'error' || call?.status === 'cancelled' ? call.status : undefined,
      error: typeof call?.error === 'string' ? call.error.slice(0, 200) : undefined,
    }
  })
}

export function messageEntries(message: {
  role: string
  content?: unknown
}): Omit<ConversationEntry, 'at'>[] {
  const { role, content } = message

  if (
    role === 'assistant' &&
    Array.isArray(content) &&
    content.some((p) => p?.type === 'toolCall')
  ) {
    return content.flatMap((part) => {
      const text = messageText({ content: [part] })
      const toolCallId =
        part.type === 'toolCall' && typeof part.id === 'string' ? part.id : undefined
      return text ? [{ role, text, toolCallId }] : []
    })
  }

  const entry = { role, text: messageText(message) }

  if (role !== 'toolResult') {
    return [entry]
  }

  return [
    {
      ...entry,
      ...callIdentity(message),
      isError: 'isError' in message && message.isError === true,
      inspectionCalls:
        'toolName' in message && message.toolName === 'codemode' && 'details' in message
          ? inspectionCalls(message.details)
          : undefined,
    },
  ]
}

export class LiveWorker {
  readonly mailbox: WorkerMailbox
  private writes = Promise.resolve()
  private lastPartial = 0
  private state: LiveWorkerState = {
    status: 'running',
    updatedAt: new Date().toISOString(),
    stage: 'starting',
  }

  private constructor(
    readonly directory: string,
    readonly info: LiveWorkerInfo,
  ) {
    this.mailbox = new WorkerMailbox(directory)
  }

  static async start(
    root: string,
    input: Omit<LiveWorkerInfo, 'id' | 'pid' | 'startedAt' | 'taskId' | 'projectRoot'>,
  ): Promise<LiveWorker> {
    const id = randomUUID()
    const rootPath = new StateStore(root).projectRoot
    const output = resolve(input.output).startsWith(resolve(root) + sep)
      ? join(rootPath, relative(root, input.output))
      : input.output
    const live = new LiveWorker(workerDirectory(root, id), {
      ...input,
      output,
      projectRoot: rootPath,
      id,
      pid: process.pid,
      taskId: input.output.match(/\/delegations\/([a-f0-9-]{36})\//)?.[1],
      startedAt: new Date().toISOString(),
    })
    await mkdir(live.directory, { recursive: true, mode: 0o700 })
    await live.mailbox.initialize()
    await atomicJson(join(live.directory, 'info.json'), live.info)
    await live.update({})
    return live
  }

  async recordClaudeModel(actualModel: string): Promise<void> {
    if (this.info.actualModel !== actualModel) {
      this.info.actualModel = actualModel
      this.info.model = `claude-cli/${actualModel}`
      await atomicJson(join(this.directory, 'info.json'), this.info)
    }
  }

  update(change: Partial<LiveWorkerState>, streaming = false): Promise<void> {
    const now = Date.now()
    this.state = { ...this.state, ...change, updatedAt: new Date(now).toISOString() }

    if (streaming && now - this.lastPartial < 500) {
      return this.writes
    }

    this.lastPartial = now
    const captured = this.state
    this.writes = this.writes.then(() => atomicJson(join(this.directory, 'state.json'), captured))
    return this.writes
  }

  append(role: string, text: string, metadata?: CallMetadata): Promise<void> {
    if (!text && !metadata?.toolCallId) {
      return this.writes
    }

    const entry: ConversationEntry = { at: new Date().toISOString(), role, text, ...metadata }
    this.writes = this.writes.then(() =>
      appendFile(join(this.directory, 'conversation.jsonl'), JSON.stringify(entry) + '\n', {
        mode: 0o600,
      }),
    )
    return this.writes
  }

  async finish(status: LiveWorkerState['status'], summary: string): Promise<void> {
    await this.mailbox.stop()
    await this.update({ status, stage: status, summary, partial: undefined, tool: undefined })
  }

  settle(): Promise<void> {
    return this.writes
  }
}
