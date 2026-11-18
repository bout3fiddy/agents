import { appendFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StateStore, atomicJson } from './state.ts'
import { WorkerMailbox } from './worker-mailbox.ts'

export type LiveWorkerInfo = {
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
export type ConversationEntry = { at: string; role: string; text: string }

export function workerDirectory(root: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) {
    throw new Error('Invalid live worker ID')
  }

  return join(new StateStore(root).directory, 'workers', id)
}

export function messageText(message: object): string {
  if (!('content' in message)) {
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

  append(role: string, text: string): Promise<void> {
    if (!text) {
      return this.writes
    }

    const entry: ConversationEntry = { at: new Date().toISOString(), role, text }
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
