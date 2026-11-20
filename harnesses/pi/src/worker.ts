import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerInspectionMode, workerInspectionTools } from './inspection-mode.ts'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import {
  ProviderQuotaError,
  type Role,
  type WorkerEvidence,
  type WorkerRequest,
} from './contracts.ts'
import { assignment, createWorkerTools } from './worker-tools.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { inventory, snapshotHash } from './paths.ts'
import { atomicJson, readJson } from './state.ts'
import { runClaudeWorker } from './claude-worker.ts'
import { workerAbortSignal } from './sandbox.ts'
import { progressReporter } from './progress.ts'
import { LiveWorker } from './worker-live.ts'
import { attachLiveSession } from './worker-live-session.ts'

export async function explicitResources(prompt: string): Promise<ResourceLoader> {

  // Resolve only the trusted inline extension. Project and home packages must never be loaded
  // into a worker. Its actual tools still resolve files against its assigned snapshot.
  const directory = await mkdtemp(join(tmpdir(), 'pi-worker-resources-'))

  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt:
        prompt +
        '\nUse codemode for two or more independent inspections or a ' +
        'search followed by bounded reads. Use Promise.allSettled for independent calls, ' +
        'surface errors and preserve evidence. Use direct tools for one simple read, ' +
        'commands, edits, reports and delegation.',
      extensionFactories: [(pi) => registerInspectionMode(pi, workerInspectionTools)],
    })
    await loader.reload()
    const extensions = loader.getExtensions()

    if (extensions.errors.length || extensions.extensions.length !== 1) {
      throw new Error('Unable to load the isolated worker inspection extension')
    }

    return loader
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Read the settled prompt outcome after the SDK has finished automatic retries.
export function checkModelOutcome(session: AgentSession): void {
  const reply = session.messages.findLast((message) => message.role === 'assistant')

  if (reply?.stopReason === 'error') {
    throw new Error(reply.errorMessage ?? 'Worker model request failed')
  }
}

export function checkWorkerThinking(session: AgentSession, thinking: Role['thinking']) {
  if (
    session.thinkingLevel !== thinking ||
    !session.getAvailableThinkingLevels().includes(thinking)
  ) {
    throw new Error(`Worker model does not support the selected thinking level: ${thinking}`)
  }
}

export async function runWorker(request: WorkerRequest): Promise<WorkerEvidence> {
  workerAbortSignal.throwIfAborted()
  const role = await loadRole(request.role, request.thinking, request.implementerModel)

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
    resourceLoader: await explicitResources(prompt),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager: SessionManager.create(request.workspace, `${request.outputPath}.sessions`),
  })
  const live = await LiveWorker.start(request.project.root, {
    role: request.role,
    model: modelId,
    thinking: session.thinkingLevel,
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

    if (event.type === 'turn_end') {
      turns++
    }
  })

  try {
    checkWorkerThinking(session, role.thinking)
    const task = await assignment(request)
    await progress.update({ stage: 'model', message: 'Executing assigned work' })
    workerAbortSignal.throwIfAborted()
    await session.prompt(JSON.stringify(task))
    workerAbortSignal.throwIfAborted()

    while (true) {
      await liveSession.settleGuidance()
      checkModelOutcome(session)

      if (worker.result() && (await live.mailbox.seal())) {
        break
      }

      await session.prompt(
        'Return the assignment result through submit_result now, ' + 'including any blockers.',
      )
      workerAbortSignal.throwIfAborted()
    }

    workerAbortSignal.throwIfAborted()

    if (!worker.result()) {
      throw new Error('Worker did not produce a result')
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
      thinking: session.thinkingLevel,
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
      ...(error instanceof ProviderQuotaError && { quotaRetryAt: error.retryAt }),
    })
    process.exitCode = 1
  }
}
