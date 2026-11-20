import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { StateStore } from './state.ts'
import type { LoadedRuntime } from './runtime-version.ts'

export function registerTiming(
  pi: ExtensionAPI,
  runtime: () => LoadedRuntime | undefined = () => undefined,
): void {
  let started = 0
  let firstText = false
  let step = 0
  let queue = Promise.resolve()
  const record = (ctx: ExtensionContext, data: Record<string, unknown>) => {
    const row = JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n'
    const folder = join(new StateStore(ctx.cwd).directory, 'timing')
    const session = ctx.sessionManager.getSessionId()
    queue = queue
      .then(async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 })
        await appendFile(join(folder, `${session}.jsonl`), row, { mode: 0o600 })
      })
      .catch(() => ctx.ui.notify('Could not persist Pi timing evidence', 'warning'))
  }
  pi.on('before_agent_start', (event, ctx) => {
    step = 0
    record(ctx, {
      event: 'request',
      trigger: event.messageType,
      model: ctx.model?.id,
      thinking: pi.getThinkingLevel(),
      runtime: runtime() && {
        loadId: runtime()!.loadId,
        version: runtime()!.version,
        revision: runtime()!.revision,
        sourceHash: runtime()!.sourceHash,
      },
    })
  })
  pi.on('turn_start', (_event, ctx) => {
    started = performance.now()
    firstText = false
    record(ctx, { event: 'model_start', step: ++step })
  })
  pi.on('message_update', (event, ctx) => {
    if (!firstText && event.assistantMessageEvent.type === 'text_delta') {
      firstText = true
      record(ctx, { event: 'first_text', step, elapsedMs: performance.now() - started })
    }
  })
  pi.on('message_end', (event, ctx) => {
    if (event.message.role === 'assistant') {
      record(ctx, {
        event: 'model_end',
        step,
        elapsedMs: performance.now() - started,
        usage: event.message.usage,
        stopReason: event.message.stopReason,
      })
    }
  })
  pi.on('tool_execution_end', (event, ctx) =>
    record(ctx, {
      event: 'tool_end',
      step,
      tool: event.toolName,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
      durationMs: event.durationMs,
      isError: event.isError,
    }),
  )
  pi.on('agent_settled', async (_event, ctx) => {
    record(ctx, { event: 'settled', steps: step })
    await queue
  })
  pi.on('session_shutdown', async () => {
    await queue
  })
}
