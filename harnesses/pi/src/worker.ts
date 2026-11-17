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
  let exhausted = false
  const timer = setTimeout(() => {
    exhausted = true
    void session.abort()
  }, role.timeoutMs)
  session.subscribe((event) => {
    if (event.type === 'turn_end') {
      turns++

      if (turns >= role.maxTurns && !worker.result()) {
        exhausted = true
        void session.abort()
      }
    }
  })

  try {
    const task = await assignment(request)
    await session.prompt(JSON.stringify(task))

    if (!worker.result() && !exhausted) {
      await session.prompt(
        'Return the assignment result through submit_result now, ' + 'including any blockers.',
      )
    }

    if (exhausted || !worker.result()) {
      throw new Error('Worker did not produce a result within its execution budget')
    }

    return {
      role: request.role,
      snapshot: snapshotHash(await inventory(request.workspace)),
      result: worker.result()!,
      commands: worker.commands,
      turns,
      model: modelId,
    }
  } finally {
    clearTimeout(timer)
    session.dispose()
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
