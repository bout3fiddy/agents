import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import {
  resultSchema,
  validateResult,
  type Checkpoint,
  type Project,
  type WorkerEvidence,
  type WorkerResult,
} from './contracts.ts'
import { dispatcher, type Dispatcher } from './dispatch.ts'
import { textResult } from './file-tools.ts'
import { changes } from './integration.ts'
import {
  inventory,
  matches,
  readBoundedFile,
  snapshotHash,
  validateScope,
  writable,
} from './paths.ts'
import { instructions } from './project.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { StateStore, atomicJson } from './state.ts'
import { explicitResources } from './worker.ts'
import { createWorkerTools } from './worker-tools.ts'

export interface TaskCoordinatorRequest {
  task: string
  context: string
  kind: 'documents' | 'research' | 'maintenance'
  workspace: string
  project: Project
  checkpoint: Checkpoint
  model: string
  outputPath: string
  baseline: Record<string, string>
  originals: string
  controlsPath?: string
}

export interface TaskCoordinatorEvidence {
  result: WorkerResult
  children: WorkerEvidence[]
  model: string
  turns: number
  controlRevision: number
}

const delegateSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('task-worker'),
      Type.Literal('implementer'),
      Type.Literal('reviewer'),
      Type.Literal('database-reviewer'),
      Type.Literal('performance'),
    ]),
    task: Type.String({ minLength: 1, maxLength: 16000 }),
    writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
  },
  { additionalProperties: false },
)

type Delegation = Static<typeof delegateSchema>
type ChildReceipt = { assignment: Delegation; evidence: WorkerEvidence }
const childBudget = 8

export function scopeContained(child: string[], parent: string[]): boolean {
  validateScope(child)
  validateScope(parent)
  return child.every((scope) =>
    parent.some(
      (outer) =>
        outer === '**' ||
        scope === outer ||
        (scope !== '**' &&
          outer.endsWith('/**') &&
          matches(scope.endsWith('/**') ? scope.slice(0, -3) : scope, outer)),
    ),
  )
}

function sameAssignment(left: Delegation, right: Delegation): boolean {
  return (
    left.role === right.role &&
    JSON.stringify([...left.writePaths].sort()) === JSON.stringify([...right.writePaths].sort())
  )
}

function isReview(role: string): boolean {
  return role === 'reviewer' || role === 'database-reviewer'
}

export async function createTaskCoordinatorTools(
  request: TaskCoordinatorRequest,
  signal: AbortSignal,
  dispatch: Dispatcher,
) {
  const role = await loadRole('task-coordinator')
  const worker = createWorkerTools({ ...request, role: 'reviewer' }, role)
  const receipts: ChildReceipt[] = []
  let submitted: WorkerResult | undefined
  let fatal: unknown
  let calls = 0
  let pending = 0
  let submitting = false
  let revision = 0
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(() => {
      signal.throwIfAborted()
      return action()
    })
    queue = next.catch(() => {})
    return next
  }

  async function delegate(raw: unknown): Promise<WorkerEvidence> {
    if (!Check(delegateSchema, raw)) {
      throw new Error('Invalid leaf assignment')
    }

    if (submitted || submitting || calls >= childBudget) {
      throw new Error('Task is already submitted or its eight-child budget is exhausted')
    }

    if (!scopeContained(raw.writePaths, request.checkpoint.writePaths)) {
      throw new Error('Child write scope exceeds the delegated task')
    }

    if (isReview(raw.role) && raw.writePaths.length) {
      throw new Error('Review workers require an empty write scope')
    }

    calls++
    pending++

    try {
      return await serialize(async () => {
        const childRole = await loadRole(raw.role)
        const before = await inventory(request.workspace)
        const child = await dispatch(
          {
            role: raw.role,
            task: JSON.stringify({
              task: raw.task,
              parentTask: request.task,
              context: request.context,
              kind: request.kind,
              authority: 'Bounded task scope; this is not an accepted implementation design.',
              previousFindings: receipts
                .filter((receipt) => sameAssignment(receipt.assignment, raw))
                .map((receipt) => receipt.evidence.result),
            }),
            workspace: request.workspace,
            project: request.project,
            checkpoint: { ...request.checkpoint, writePaths: raw.writePaths },
            model: request.model,
            baseline: request.baseline,
            originals: request.originals,
          },
          signal,
        )
        signal.throwIfAborted()
        const after = await inventory(request.workspace)

        if (child.role !== raw.role || child.snapshot !== snapshotHash(after)) {
          throw new Error('Stale or mismatched child evidence')
        }

        validateResult(child.result)

        const expectedModel = childRole.model === 'inherit' ? request.model : childRole.model
        const actualModel =
          childRole.backend === 'claude-cli'
            ? child.model.replace(/^claude-cli\//, '')
            : child.model

        if (actualModel !== expectedModel) {
          throw new Error('Child model does not match its configured role')
        }

        if (
          !Number.isSafeInteger(child.turns) ||
          child.turns < 1 ||
          child.turns > childRole.maxTurns
        ) {
          throw new Error('Child exceeded its turn budget')
        }

        const roleScopes =
          raw.role === 'performance'
            ? [...childRole.writes, ...request.project.instrumentationPaths]
            : childRole.writes

        for (const path of changes(before, after)) {
          if (
            isReview(raw.role) ||
            !writable(path, raw.writePaths) ||
            !writable(path, roleScopes)
          ) {
            throw new Error(`Child edited outside its role or assignment: ${path}`)
          }
        }

        receipts.push({ assignment: raw, evidence: child })
        await atomicJson(`${request.outputPath}.children.json`, receipts)
        return child
      })
    } catch (error) {
      fatal = error
      throw error
    } finally {
      pending--
    }
  }

  async function validatePass(): Promise<void> {
    signal.throwIfAborted()

    if (pending || fatal) {
      throw new Error('Unfinished or failed child execution prevents a passing result')
    }

    const snapshot = snapshotHash(await inventory(request.workspace))

    for (const [index, receipt] of receipts.entries()) {
      if (receipt.evidence.result.verdict === 'pass' && !isReview(receipt.evidence.role)) {
        continue
      }

      const latest = receipts
        .slice(index)
        .findLast((candidate) => sameAssignment(receipt.assignment, candidate.assignment))!

      if (latest.evidence.result.verdict !== 'pass' || latest.evidence.snapshot !== snapshot) {
        throw new Error(
          'Resolve child findings and refresh requested reviews on the final snapshot',
        )
      }
    }
  }

  const tools: ToolDefinition[] = worker.tools
    .filter((tool) => tool.name !== 'submit_result')
    .map((tool) => ({
      ...tool,
      execute: (...args: Parameters<ToolDefinition['execute']>) =>
        serialize(() => tool.execute(args[0], args[1], signal, args[3], args[4])),
    }))
  tools.push(
    {
      name: 'delegate_worker',
      label: 'Delegate bounded leaf task',
      description: 'Run one scoped leaf worker, await its receipt. At most eight calls per task.',
      parameters: delegateSchema,
      async execute(_id, raw) {
        return textResult(await delegate(raw))
      },
    },
    {
      name: 'submit_result',
      label: 'Submit coordinated task result',
      description: 'Submit only after all children finish and required findings are resolved.',
      parameters: resultSchema,
      async execute(_id, raw) {
        signal.throwIfAborted()

        if (pending || submitting) {
          throw new Error('Wait for all child workers before submitting')
        }

        const result = validateResult(raw)
        const submittedRevision = revision
        submitting = true

        try {
          if (result.verdict === 'pass') {
            await validatePass()
          }

          if (submittedRevision !== revision) {
            throw new Error('Task controls changed; submit a fresh result after applying them')
          }

          submitted = result
          return textResult({ submitted: true })
        } finally {
          submitting = false
        }
      },
    },
  )
  return {
    tools,
    children: () => receipts.map((receipt) => receipt.evidence),
    result: () => submitted,
    invalidateResult: () => {
      submitted = undefined
      revision++
    },
    settle: async () => {
      await queue
    },
    validatePass,
  }
}

const controlsSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  messages: Type.Array(
    Type.Object({
      revision: Type.Integer({ minimum: 1 }),
      text: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    { maxItems: 100 },
  ),
  cancelled: Type.Boolean(),
})

export async function runTaskCoordinator(
  request: TaskCoordinatorRequest,
  signal: AbortSignal,
): Promise<TaskCoordinatorEvidence> {
  signal.throwIfAborted()
  const traceRoot = resolve(request.project.root, '.pi', 'traces') + sep

  if (
    !resolve(request.outputPath).startsWith(traceRoot) ||
    resolve(request.outputPath).startsWith(resolve(request.workspace) + sep)
  ) {
    throw new Error('Coordinator traces must use the original project private trace directory')
  }

  const role = await loadRole('task-coordinator')
  const modelId = role.model === 'inherit' ? request.model : role.model
  const split = modelId.indexOf('/')

  if (split < 1) {
    throw new Error('Coordinator model must include provider/model')
  }

  const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const model = modelRuntime.getModel(modelId.slice(0, split), modelId.slice(split + 1))

  if (!model) {
    throw new Error(`Configured coordinator model is unavailable: ${modelId}`)
  }

  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  const store = new StateStore(request.project.root, dirname(request.outputPath))
  const worker = await createTaskCoordinatorTools(request, combined, dispatcher(store))
  const { session } = await createAgentSession({
    cwd: request.workspace,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: role.thinking,
    tools: role.tools,
    customTools: worker.tools,
    resourceLoader: explicitResources(await rolePrompt('task-coordinator')),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager: SessionManager.create(request.workspace, `${request.outputPath}.sessions`),
  })
  let turns = 0
  let controlRevision = 0
  let queuedRevision = 0
  let controlsError: unknown
  const steering = new Map<string, number>()
  const abort = () => {
    void session.abort()
  }
  combined.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error('Task coordinator timed out')),
    role.timeoutMs,
  )
  session.subscribe((event) => {
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = event.message.content
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')
      const revision = steering.get(text)

      if (revision !== undefined) {
        worker.invalidateResult()
        controlRevision = Math.max(controlRevision, revision)
        steering.delete(text)
      }
    }

    if (event.type === 'turn_end') {
      turns++

      if (turns >= role.maxTurns && !worker.result()) {
        controller.abort(new Error('Task coordinator exhausted its turn budget'))
      }
    }
  })

  async function pollControls(): Promise<void> {
    if (!request.controlsPath || combined.aborted) {
      return
    }

    const controls: unknown = JSON.parse(
      (await readBoundedFile(request.controlsPath, 512000)).toString('utf8'),
    )

    if (!Check(controlsSchema, controls)) {
      throw new Error('Invalid task controls')
    }

    if (controls.cancelled) {
      controller.abort(new Error('Task cancelled by user'))
      return
    }

    for (const message of controls.messages) {
      if (message.revision <= queuedRevision) {
        continue
      }

      if (message.revision !== queuedRevision + 1 || message.revision > controls.revision) {
        throw new Error('Task control revisions are incomplete or unordered')
      }

      const text = JSON.stringify({
        taskControlRevision: message.revision,
        taskUpdate: message.text,
        immutableWriteScope: request.checkpoint.writePaths,
        instruction: 'Apply this update within the existing scope and submit a fresh result.',
      })
      worker.invalidateResult()
      steering.set(text, message.revision)
      await session.steer(text)
      queuedRevision = message.revision
    }

    if (queuedRevision !== controls.revision) {
      throw new Error('Task control revision has no corresponding messages')
    }
  }

  let poll: Promise<void> = Promise.resolve()

  function refreshControls(): Promise<void> {
    poll = poll.then(pollControls).catch((error: unknown) => {
      controlsError = error
      controller.abort(error)
    })
    return poll
  }

  const controlsTimer = setInterval(() => {
    void refreshControls()
  }, 300)

  try {
    await refreshControls()
    combined.throwIfAborted()
    await session.prompt(
      JSON.stringify({
        task: request.task,
        context: request.context,
        kind: request.kind,
        taskScope: request.checkpoint,
        folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
        childBudget,
      }),
    )
    await refreshControls()
    combined.throwIfAborted()

    if (!worker.result()) {
      await session.prompt('Finish through submit_result, reporting remaining blockers honestly.')
    }

    await worker.settle()
    combined.throwIfAborted()

    if (controlsError || !worker.result() || turns > role.maxTurns) {
      throw new Error('Coordinator did not produce a result within its execution budget')
    }

    if (worker.result()!.verdict === 'pass') {
      await worker.validatePass()
    }

    const result = worker.result()

    if (!result) {
      throw new Error('Task controls changed before completion; a fresh result is required')
    }

    return {
      result,
      children: worker.children(),
      model: modelId,
      turns,
      controlRevision,
    }
  } finally {
    clearTimeout(timer)
    clearInterval(controlsTimer)
    combined.removeEventListener('abort', abort)
    controller.abort()
    await poll
    await session.abort()
    await worker.settle()
    session.dispose()
    await modelRuntime.settleCredentialWrites()
  }
}
