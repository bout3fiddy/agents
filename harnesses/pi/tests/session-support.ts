import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'

export function registerCapture(
  runtime: ModelRuntime,
  respond: (context: Context) => Promise<AssistantMessage['content']>,
  reasoning = false,
) {
  runtime.registerProvider('capture', {
    api: 'openai-completions',
    baseUrl: 'http://unused',
    apiKey: 'test-only',
    models: [
      {
        id: 'capture',
        name: 'Capture',
        reasoning,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 300000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream()
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      respond(context)
        .then((content) => {
          message.content = content
          message.stopReason = content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop'
          stream.push({ type: 'start', partial: message })
          stream.push({ type: 'done', reason: message.stopReason, message })
          stream.end()
        })
        .catch((error: Error) => {
          message.stopReason = 'error'
          message.errorMessage = error.message
          stream.push({ type: 'error', reason: 'error', error: message })
          stream.end()
        })
      return stream
    },
  })
}

export async function captureSession(
  root: string,
  base: string,
  extensions: ExtensionFactory[],
  respond: (context: Context) => Promise<AssistantMessage['content']>,
  options: { extensionPaths?: string[] } & Pick<
    CreateAgentSessionOptions,
    'tools' | 'resourceLoader' | 'customTools'
  > = {},
) {
  const runtime = await ModelRuntime.create({
    authPath: join(base, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(base, 'catalog.json'),
    refreshOnCreate: false,
  })
  registerCapture(runtime, respond)
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: base,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: extensions,
    additionalExtensionPaths: options.extensionPaths,
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: base,
    modelRuntime: runtime,
    model: runtime.getModel('capture', 'capture')!,
    settingsManager,
    resourceLoader: options.resourceLoader ?? loader,
    ...(options.tools && { tools: options.tools }),
    ...(options.customTools && { customTools: options.customTools }),
    sessionManager: SessionManager.create(root, join(base, 'sessions')),
  })
  await session.bindExtensions({
    onError: (error) => {
      throw new Error(JSON.stringify(error))
    },
  })
  return { session, runtime }
}
