import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type { WorkerEvidence, WorkerRequest } from './contracts.ts'
import { assignment, createWorkerTools } from './worker-tools.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { inventory, snapshotHash } from './paths.ts'
import { atomicJson, readJson } from './state.ts'
import { runClaudeWorker } from './claude-worker.ts'
import { workerAbortSignal } from './sandbox.ts'
import { progressReporter } from './progress.ts'
import { LiveWorker } from './worker-live.ts'
import { attachLiveSession } from './worker-live-session.ts'

export function explicitResources(prompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

export async function runWorker(request: WorkerRequest): Promise<WorkerEvidence> {
  workerAbortSignal.throwIfAborted()
  const role = await loadRole(request.role)

  if (role.backend === 'claude-cli') {
    return runClaudeWorker(request, role)
  }

  const modelId = role.model === 'inherit' ? request.model : role.model
  const split = modelId.indexOf('/')

  if (split < 1) {
    throw new Error('Worker model must include provider/model')
  }

  const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const model = modelRuntime.getModel(modelId.slice(0, split), modelId.slice(split + 1))

  if (!model) {
    throw new Error(`Configured worker model is unavailable: ${modelId}`)
  }

  const worker = createWorkerTools(request, role)
  const progress = progressReporter(request.outputPath, request.role)
  let turns = 0
  const prompt = await rolePrompt(request.role)
  const { session } = await createAgentSession({
    cwd: request.workspace,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: role.thinking,
    tools: role.tools,
    customTools: worker.tools,
    resourceLoader: explicitResources(prompt),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager: SessionManager.create(request.workspace, `${request.outputPath}.sessions`),
  })
  const live = await LiveWorker.start(request.project.root, {
    role: request.role,
    model: modelId,
    task: request.task,
    scope: request.checkpoint.writePaths,
    writeLimits: role.writes,
    output: request.outputPath,
    workspace: request.workspace,
    backend: 'pi',
    parentId: request.parentWorkerId,
    reviewOf: request.reviewOf,
  })
  const liveSession = attachLiveSession(session, live, worker.invalidateResult)
  let modelError: string | undefined
  const abort = () => {
    void session.abort()
  }
  workerAbortSignal.addEventListener('abort', abort, { once: true })
  session.subscribe((event) => {
    if (event.type === 'message_update') {
      void progress.update({ stage: 'model', tool: undefined }, true).catch(() => {})
    }

    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      void progress
        .update({
          stage: event.type === 'tool_execution_start' ? 'tool' : 'model',
          tool: event.toolName,
        })
        .catch(() => {})
    }

    if (
      event.type === 'message_end' &&
      event.message.role === 'assistant' &&
      event.message.stopReason === 'error'
    ) {
      modelError = event.message.errorMessage ?? 'Worker model request failed'
    }

    if (event.type === 'turn_end') {
      turns++
    }
  })

  try {
    const task = await assignment(request)
    await progress.update({ stage: 'model', message: 'Executing assigned work' })
    workerAbortSignal.throwIfAborted()
    await session.prompt(JSON.stringify(task))
    workerAbortSignal.throwIfAborted()

    while (true) {
      await liveSession.settleGuidance()

      if (worker.result() && (await live.mailbox.seal())) {
        break
      }

      if (modelError) {
        throw new Error(modelError)
      }

      await session.prompt(
        'Return the assignment result through submit_result now, ' + 'including any blockers.',
      )
      workerAbortSignal.throwIfAborted()
    }

    workerAbortSignal.throwIfAborted()

    if (modelError || !worker.result()) {
      throw new Error(modelError ?? 'Worker did not produce a result')
    }

    await progress.update({ stage: 'complete', message: worker.result()!.summary })
    await live.finish(
      worker.result()!.verdict === 'pass' ? 'complete' : 'needs_attention',
      worker.result()!.summary,
    )
    return {
      role: request.role,
      liveWorkerId: live.info.id,
      snapshot: snapshotHash(await inventory(request.workspace)),
      result: worker.result()!,
      commands: worker.commands,
      turns,
      model: modelId,
    }
  } catch (error) {
    await live.finish(workerAbortSignal.aborted ? 'cancelled' : 'failed', String(error))
    throw error
  } finally {
    workerAbortSignal.removeEventListener('abort', abort)
    session.dispose()
    await liveSession.dispose()
    await progress.settle()
    await modelRuntime.settleCredentialWrites()
  }
}

if (process.argv[2] === '--worker') {
  const request = await readJson<WorkerRequest>(process.argv[3]!)

  if (!request) {
    throw new Error('Missing worker request')
  }

  try {
    const evidence = await runWorker(request)
    await atomicJson(request.outputPath, { evidence })
  } catch (error) {
    await atomicJson(request.outputPath, {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  }
}
