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
  thinkingSchema,
  specialistThinkingSchema,
  ProviderQuotaError,
  validateResult,
  writePathSchema,
  type Checkpoint,
  type Project,
  type Receipt,
  type WorkerEvidence,
  type WorkerResult,
  type Role,
} from './contracts.ts'
import { collectWorkerResults, dispatcher, type Dispatcher } from './dispatch.ts'
import { bindFormatterProof, formatterClosures } from './formatter-review.ts'
import { textResult } from './file-tools.ts'
import { changes } from './integration.ts'
import {
  documentPath,
  inventory,
  matches,
  readBoundedFile,
  snapshotHash,
  validateScope,
  validateWriteScope,
  writable,
} from './paths.ts'
import { instructions, verifyProject } from './project.ts'
import { benchmarks, databaseImpact } from './workflow.ts'
import { receiptView } from './context.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { StateStore, atomicJson } from './state.ts'
import { checkModelOutcome, checkWorkerThinking, explicitResources } from './worker.ts'
import { createWorkerTools } from './worker-tools.ts'
import { progressReporter } from './progress.ts'
import { capabilities } from './capabilities.ts'
import { LiveWorker } from './worker-live.ts'
import { attachLiveSession } from './worker-live-session.ts'

export interface TaskCoordinatorRequest {
  thinking?: Role['thinking']
  task: string
  context: string
  kind: 'documents' | 'research' | 'maintenance' | 'branch'
  workspace: string
  project: Project
  checkpoint: Checkpoint
  model: string
  outputPath: string
  baseline: Record<string, string>
  originals: string
  controlsPath?: string
  review?: boolean
  resumed?: boolean
}

export interface TaskCoordinatorEvidence {
  thinking?: string
  result: WorkerResult
  children: WorkerEvidence[]
  model: string
  turns: number
  controlRevision: number
  checks?: Receipt[]
}

const freshReviewReason = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 500,
    description: 'New concern that needs independent review after a formatter-verified closure.',
  }),
)

const delegateSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('task-worker'),
      Type.Literal('implementer'),
      Type.Literal('reviewer'),
      Type.Literal('database-reviewer'),
      Type.Literal('performance'),
    ]),
    thinking: Type.Optional(thinkingSchema),
    freshReviewReason,
    task: Type.String({ minLength: 1, maxLength: 16000 }),
    writePaths: Type.Array(writePathSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
)

const reviewTask = Type.String({ minLength: 1, maxLength: 16000 })
const reviewPairSchema = Type.Object(
  {
    engineering: reviewTask,
    database: reviewTask,
    freshReviewReason,
    engineeringThinking: Type.Optional(specialistThinkingSchema),
    databaseThinking: Type.Optional(specialistThinkingSchema),
  },
  { additionalProperties: false },
)

type Delegation = Static<typeof delegateSchema>
type ChildReceipt = { assignment: Delegation; evidence: WorkerEvidence }
const coordinatorRole = (request: TaskCoordinatorRequest) =>
  request.kind === 'branch' ? 'branch-orchestrator' : 'task-coordinator'

export function scopeContained(child: string[], parent: string[]): boolean {
  validateWriteScope(child)
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

function reviewVerdicts(results: WorkerEvidence[]) {
  return results.map(({ role, model, thinking, snapshot, result }) => ({
    role,
    model,
    thinking,
    snapshot,
    result,
  }))
}

function checkChildWrites(
  request: TaskCoordinatorRequest,
  assignment: Delegation,
  role: Role,
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
) {
  const allowed =
    assignment.role === 'performance'
      ? [...role.writes, ...request.project.instrumentationPaths]
      : role.writes

  for (const path of changes(before, after)) {
    if (request.kind === 'branch' && assignment.role === 'task-worker' && !documentPath(path)) {
      throw new Error('Branch code implementation requires the implementer role')
    }

    if (
      isReview(assignment.role) ||
      !writable(path, assignment.writePaths) ||
      !writable(path, allowed)
    ) {
      throw new Error(`Child edited outside its role or assignment: ${path}`)
    }
  }
}

export async function createTaskCoordinatorTools(
  request: TaskCoordinatorRequest,
  signal: AbortSignal,
  dispatch: Dispatcher,
) {
  const role = await loadRole(coordinatorRole(request), request.thinking)
  const worker = createWorkerTools({ ...request, role: 'reviewer' }, role)
  const progress = progressReporter(request.outputPath, role.name)
  const receipts: ChildReceipt[] = []
  const originals =
    request.kind === 'branch' || request.kind === 'maintenance'
      ? await inventory(request.originals)
      : undefined
  let checks: Receipt[] = []
  let checkedDatabase = false
  let declaredDatabase = request.checkpoint.database
  let submitted: WorkerResult | undefined
  let fatal: unknown
  const failedAssignments = new Set<string>()
  const rejectedModels = new Map<string, ProviderQuotaError>()
  const missingVerdicts = new Set<string>()
  let reviewSnapshot: string | undefined
  let pairedReviewActive = false
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

  function requireValidCandidate() {
    if (fatal) {
      throw new Error(
        `Previous failed child execution invalidated this candidate: ${String(fatal)}. ` +
          'Submit blocked with the cause and retained evidence so the host can recover.',
      )
    }
  }

  function validateAssignment(raw: unknown): Delegation {
    if (!Check(delegateSchema, raw)) {
      throw new Error('Invalid leaf assignment')
    }

    if (submitted || submitting) {
      throw new Error('Task is already submitted')
    }

    if (!scopeContained(raw.writePaths, request.checkpoint.writePaths)) {
      throw new Error('Child write scope exceeds the delegated task')
    }

    if (isReview(raw.role) && raw.writePaths.length) {
      throw new Error('Review workers require an empty write scope')
    }

    const documentsOnly = request.kind === 'branch' && raw.role === 'task-worker'

    if (
      documentsOnly &&
      raw.writePaths.some((path) => path !== '**' && !path.endsWith('/**') && !documentPath(path))
    ) {
      throw new Error(
        'Assign branch JSON, manifests and code to implementer. ' +
          'The branch task-worker can edit .md, .txt and .rst documents.',
      )
    }

    return raw
  }

  async function runChild(
    raw: Delegation,
    before: Map<string, Buffer>,
    changedFiles: string[] | undefined,
  ): Promise<ChildReceipt[]> {
    const documentsOnly = request.kind === 'branch' && raw.role === 'task-worker'
    const assignmentKey = JSON.stringify([raw.role, [...raw.writePaths].sort()])
    let recoverableFailure = false

    try {
      const childRole = await loadRole(raw.role)
      await progress.update({
        stage: 'child',
        role: raw.role,
        child: undefined,
        message: raw.task.slice(0, 240),
      })
      let child: WorkerEvidence

      try {
        const rejected = rejectedModels.get(childRole.model)

        if (rejected && rejected.retryAt > Date.now()) {
          throw rejected
        }

        child = await dispatch(
          {
            role: raw.role,
            thinking: raw.thinking,
            documentsOnly,
            task: JSON.stringify({
              task: raw.task,
              parentTask: request.task,
              context: request.context,
              kind: request.kind,
              capabilities: capabilities.workers,
              execution: { state: 'running', resumed: request.resumed ?? false },
              authority:
                request.kind === 'branch'
                  ? 'Authorized design-document implementation; resolve reviewer feedback.'
                  : 'Bounded task scope; this is not an accepted implementation design.',
              ...(raw.freshReviewReason && { freshReviewReason: raw.freshReviewReason }),
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
            changedFiles,
          },
          signal,
          (activity) => progress.update({ stage: 'child', role: raw.role, child: activity }),
        )
      } catch (error) {
        checkChildWrites(request, raw, childRole, before, await inventory(request.workspace))

        if (error instanceof ProviderQuotaError) {
          rejectedModels.set(childRole.model, error)
        }

        recoverableFailure = true
        failedAssignments.add(assignmentKey)
        throw error
      }

      signal.throwIfAborted()
      const after = await inventory(request.workspace)

      if (child.role !== raw.role || child.snapshot !== snapshotHash(after)) {
        throw new Error('Stale or mismatched child evidence')
      }

      validateResult(child.result)

      const expectedModel = childRole.model === 'inherit' ? request.model : childRole.model
      const actualModel =
        childRole.backend === 'claude-cli' ? child.model.replace(/^claude-cli\//, '') : child.model

      if (actualModel !== expectedModel) {
        throw new Error('Child model does not match its configured role')
      }

      if (!Number.isSafeInteger(child.turns) || child.turns < 1) {
        throw new Error('Invalid child turn telemetry')
      }

      checkChildWrites(request, raw, childRole, before, after)

      const completed = [{ assignment: raw, evidence: child }]

      if (isReview(raw.role)) {
        await bindFormatterProof(child, before, request.workspace, request.checkpoint.writePaths)
      } else {
        const history = receipts.map((receipt) => receipt.evidence)

        for (const closure of formatterClosures(history, after)) {
          const prior = receipts.findLast((receipt) => receipt.assignment.role === closure.role)!
          completed.push({ assignment: prior.assignment, evidence: closure })
        }
      }

      failedAssignments.delete(assignmentKey)
      return completed
    } catch (error) {
      if (!recoverableFailure && !fatal) {
        fatal = error
      }

      await progress.update({ stage: 'issue', message: String(error).slice(0, 500) })
      throw error
    }
  }

  function reviewed(roleName: string, snapshot: string) {
    return receipts.findLast(
      ({ evidence }) => evidence.role === roleName && evidence.snapshot === snapshot,
    )?.evidence
  }

  async function delegateRound(assignments: Delegation[]): Promise<WorkerEvidence[]> {
    if (pairedReviewActive) {
      throw new Error('Wait for both review verdicts before delegating further work')
    }

    const paired = assignments.length === 2

    if (paired) {
      pairedReviewActive = true
    }

    pending++

    try {
      return await serialize(async () => {
        requireValidCandidate()
        const before = await inventory(request.workspace)
        const snapshot = snapshotHash(before)

        if (missingVerdicts.size && reviewSnapshot !== snapshot) {
          throw new Error('Candidate changed while waiting for outstanding review verdicts')
        }

        if (missingVerdicts.size && assignments.some((item) => !missingVerdicts.has(item.role))) {
          throw new Error(
            'Collect only the outstanding review verdicts with delegate_worker: ' +
              [...missingVerdicts].join(', '),
          )
        }

        const single = assignments.length === 1 ? assignments[0] : undefined
        const requiresBoth =
          request.kind === 'branch' || (request.kind === 'maintenance' && request.review !== false)

        if (
          single &&
          isReview(single.role) &&
          requiresBoth &&
          !missingVerdicts.size &&
          (await needsDatabase(before)) &&
          !reviewed(single.role === 'reviewer' ? 'database-reviewer' : 'reviewer', snapshot)
        ) {
          throw new Error(
            'Use delegate_reviews for engineering and database review on this candidate',
          )
        }

        const completingReview = missingVerdicts.size > 0

        if (paired) {
          reviewSnapshot = snapshot

          for (const item of assignments) {
            missingVerdicts.add(item.role)
          }
        }

        const changedFiles = originals && changes(originals, before)
        const groups = await collectWorkerResults(
          assignments.map((assignment) => {
            const prior = receipts.findLast((r) => sameAssignment(assignment, r.assignment))

            if (
              !assignment.freshReviewReason &&
              prior?.evidence.closedReview &&
              prior.evidence.snapshot === snapshot
            ) {
              return Promise.resolve([prior])
            }

            return runChild(assignment, before, changedFiles)
          }),
          async (completed) => {
            const children = completed.flat()

            if (paired && snapshotHash(await inventory(request.workspace)) !== snapshot) {
              fatal = new Error('Candidate changed during paired review')
              throw fatal
            }

            const additions = children.filter((child) => !receipts.includes(child))

            try {
              await atomicJson(`${request.outputPath}.children.json`, [...receipts, ...additions])
            } catch (error) {
              fatal = error
              throw error
            }

            receipts.push(...additions)

            for (const child of children) {
              missingVerdicts.delete(child.assignment.role)
            }
          },
        )

        const finished = groups.flat()

        if (
          requiresBoth &&
          single?.role === 'reviewer' &&
          finished[0]?.evidence.result.databaseImpact &&
          !reviewed('database-reviewer', snapshot)
        ) {
          reviewSnapshot = snapshot
          missingVerdicts.add('database-reviewer')
        }

        await progress.update({
          stage: 'coordinating',
          role: role.name,
          child: undefined,
          message: finished
            .map(
              ({ evidence }) =>
                `${evidence.role}: ${evidence.result.verdict}. ` +
                evidence.result.summary.slice(0, 200),
            )
            .join(' / '),
        })

        if (completingReview && missingVerdicts.size === 0) {
          return [reviewed('reviewer', snapshot)!, reviewed('database-reviewer', snapshot)!]
        }

        return finished.map((child) => child.evidence)
      })
    } catch (error) {
      if (paired && missingVerdicts.size && !fatal && !signal.aborted) {
        throw new Error(
          `${String(error)}. Outstanding reviews: ${[...missingVerdicts].join(', ')}`,
          { cause: error },
        )
      }

      throw error
    } finally {
      if (paired) {
        pairedReviewActive = false
      }

      pending--
    }
  }

  async function needsDatabase(candidate?: Map<string, Buffer>): Promise<boolean> {
    return Boolean(
      declaredDatabase ||
      receipts.some((receipt) => receipt.evidence.result.databaseImpact) ||
      (originals &&
        databaseImpact(
          originals,
          candidate ?? (await inventory(request.workspace)),
          request.project.databasePaths,
        )),
    )
  }

  async function validateBranch(snapshot: string): Promise<void> {
    const database = await needsDatabase()
    const performance =
      request.checkpoint.performance ||
      receipts.some((receipt) => receipt.evidence.role === 'performance')
    const requiredRoles = [
      'reviewer',
      ...(database ? ['database-reviewer'] : []),
      ...(performance ? ['performance'] : []),
    ]

    for (const name of requiredRoles) {
      const review = receipts.findLast((receipt) => receipt.evidence.role === name)?.evidence

      if (!review || review.result.verdict !== 'pass' || review.snapshot !== snapshot) {
        throw new Error(`Branch completion requires a passing ${name} on the final candidate`)
      }
    }

    const required = [
      'harness-lint',
      ...request.project.checks
        .filter((check) => check.required && (check.kind !== 'benchmark' || performance))
        .map((check) => check.id),
    ]

    if (
      !checks.length ||
      (database && !checkedDatabase) ||
      checks.some((check) => check.snapshot !== snapshot) ||
      checks.some(
        (check) =>
          check.status !== 'passed' &&
          (required.includes(check.check) || check.check.startsWith('required-')),
      ) ||
      required.some(
        (id) => !checks.some((check) => check.check === id && check.status === 'passed'),
      )
    ) {
      throw new Error('Run run_checks and resolve required failures on the final candidate')
    }
  }

  async function validatePass(): Promise<void> {
    signal.throwIfAborted()

    requireValidCandidate()

    if (pending || failedAssignments.size || missingVerdicts.size) {
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
          'Resolve child findings and refresh requested reviews on the final snapshot. ' +
            'Outstanding assignment: ' +
            JSON.stringify({
              role: receipt.assignment.role,
              writePaths: receipt.assignment.writePaths,
              verdict: latest.evidence.result.verdict,
              snapshotMatches: latest.evidence.snapshot === snapshot,
            }) +
            '. Delegate this exact role and writePaths to resolve its prior findings. ' +
            'A read-only follow-up with different writePaths does not clear this assignment. ' +
            'Keep the same scope even if no edits are needed. ' +
            'Reuse passing reviews when unchanged.',
        )
      }
    }

    if (request.kind === 'branch') {
      await validateBranch(snapshot)
    }
  }

  const tools: ToolDefinition[] = worker.tools
    .filter((tool) => tool.name !== 'submit_result')
    .map((tool) => ({
      ...tool,
      execute: (...args: Parameters<ToolDefinition['execute']>) =>
        serialize(() => tool.execute(args[0], args[1], signal, args[3], args[4])),
    }))

  tools.push({
    name: 'report_milestone',
    label: 'Report a project milestone',
    description:
      'Flag a verified outcome or material change of plan for the host. Summarize the current ' +
      'outcome, evidence and impact in one or two sentences. Routine progress stays private.',
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 400 }) }),
    async execute(_id, raw) {
      const { summary } = raw as { summary: string }
      return serialize(async () => {
        if (submitted || submitting || !summary.trim()) {
          throw new Error('An active task and a concrete milestone are required')
        }

        await progress.update({ milestone: summary.trim() })
        return textResult({ recorded: true })
      })
    },
  })

  if (request.kind === 'branch') {
    tools.push({
      name: 'run_checks',
      label: 'Run branch acceptance checks',
      description:
        'Run the configured required tests, lint, recovery checks and benchmarks. ' +
        'Repair failures through workers, then rerun after any retained edit.',
      parameters: Type.Object({}),
      async execute() {
        pending++

        try {
          return await serialize(async () => {
            if (submitted || submitting) {
              throw new Error('Task is already submitted')
            }

            requireValidCandidate()
            checks = []
            checkedDatabase = false
            checkedDatabase = await needsDatabase()
            checks = await verifyProject(
              request.workspace,
              request.project,
              checkedDatabase,
              signal,
              { files: originals!, writePaths: request.checkpoint.writePaths },
            )

            if (
              request.checkpoint.performance ||
              receipts.some((receipt) => receipt.evidence.role === 'performance')
            ) {
              checks.push(...(await benchmarks(request.workspace, request.project, signal)))
            }

            await atomicJson(`${request.outputPath}.checks.json`, checks)
            return textResult({ database: checkedDatabase, checks: checks.map(receiptView) })
          })
        } finally {
          pending--
        }
      },
    })
  }

  tools.push(
    {
      name: 'delegate_worker',
      label: 'Delegate bounded leaf task',
      description:
        'Choose thinking for this leaf: low for mechanical tasks, medium for settled designs, ' +
        'high for unresolved tradeoffs or tricky repairs. Fable specialists support medium/high. ' +
        'Engineering and database reviews default to high.',
      parameters: delegateSchema,
      async execute(_id, raw) {
        const child = validateAssignment(raw)

        if (child.thinking !== undefined) {
          await loadRole(child.role, child.thinking)
        }

        const results = await delegateRound([child])
        const result = results[0]!

        if (!isReview(child.role) && results.length > 1) {
          return textResult({ ...result, closedReviews: reviewVerdicts(results.slice(1)) })
        }

        return textResult(results.length === 1 ? result : reviewVerdicts(results))
      },
    },
    {
      name: 'delegate_reviews',
      label: 'Run engineering and database reviews',
      description:
        'Use when both reviews apply. Run both on this frozen candidate and return ' +
        'both verdicts together before assigning any repairs.',
      parameters: reviewPairSchema,
      async execute(_id, raw) {
        if (!Check(reviewPairSchema, raw)) {
          throw new Error('Provide engineering and database review assignments')
        }

        const assignments = [
          validateAssignment({
            role: 'reviewer',
            task: raw.engineering,
            writePaths: [],
            ...(raw.freshReviewReason && { freshReviewReason: raw.freshReviewReason }),
            ...(raw.engineeringThinking && { thinking: raw.engineeringThinking }),
          }),
          validateAssignment({
            role: 'database-reviewer',
            task: raw.database,
            writePaths: [],
            ...(raw.freshReviewReason && { freshReviewReason: raw.freshReviewReason }),
            ...(raw.databaseThinking && { thinking: raw.databaseThinking }),
          }),
        ]
        return textResult(reviewVerdicts(await delegateRound(assignments)))
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
        declaredDatabase ||= result.databaseImpact
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
          await progress.update({
            stage: result.verdict === 'blocked' ? 'blocked' : 'complete',
            message: result.summary,
            child: undefined,
          })
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
    checks: () => checks,
    result: () => submitted,
    invalidateResult: () => {
      submitted = undefined
      rejectedModels.clear()
      revision++
    },
    settle: async () => {
      await queue
    },
    validatePass,
    progress,
  }
}

const controlsSchema = Type.Object({
  baseRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  revision: Type.Integer({ minimum: 0 }),
  messages: Type.Array(
    Type.Object({
      revision: Type.Integer({ minimum: 1 }),
      text: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    { maxItems: 100 },
  ),
  cancelled: Type.Boolean(),
  paused: Type.Optional(Type.Boolean()),
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

  const role = await loadRole(coordinatorRole(request), request.thinking)
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
  const live = await LiveWorker.start(request.project.root, {
    role: coordinatorRole(request),
    model: modelId,
    thinking: role.thinking,
    task: request.task,
    scope: request.checkpoint.writePaths,
    output: request.outputPath,
    workspace: request.workspace,
    backend: 'pi',
  })
  const dispatch = dispatcher(store)
  let lastAuthor: string | undefined
  const worker = await createTaskCoordinatorTools(
    request,
    combined,
    async (child, abortSignal, progress) => {
      const review = ['reviewer', 'database-reviewer', 'performance'].includes(child.role)
      const evidence = await dispatch(
        { ...child, parentWorkerId: live.info.id, reviewOf: review ? lastAuthor : undefined },
        abortSignal,
        progress,
      )

      if (['implementer', 'task-worker'].includes(child.role)) {
        lastAuthor = evidence.liveWorkerId
      }

      return evidence
    },
  )
  const { session } = await createAgentSession({
    cwd: request.workspace,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: role.thinking,
    tools: role.tools,
    customTools: worker.tools,
    resourceLoader: explicitResources(await rolePrompt(coordinatorRole(request))),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager: SessionManager.create(request.workspace, `${request.outputPath}.sessions`),
  })
  const liveSession = attachLiveSession(session, live, worker.invalidateResult)
  let turns = 0
  let controlRevision = 0
  let queuedRevision = 0
  let baseRevision: number | undefined
  let controlsError: unknown
  const steering = new Map<string, number>()
  const abort = () => {
    void session.abort()
  }
  combined.addEventListener('abort', abort, { once: true })
  session.subscribe((event) => {
    if (event.type === 'message_update') {
      void worker.progress.update({ stage: 'coordinating', child: undefined }, true).catch(() => {})
    }

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

    if (controls.paused) {
      controller.abort(new Error('Task paused for inspection'))
      return
    }

    if (baseRevision === undefined) {
      baseRevision = controls.baseRevision ?? 0
      controlRevision = baseRevision
      queuedRevision = baseRevision
    } else if (baseRevision !== (controls.baseRevision ?? 0)) {
      throw new Error('Task assignment changed without stopping the coordinator')
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
    checkWorkerThinking(session, role.thinking)
    await refreshControls()
    combined.throwIfAborted()
    await session.prompt(
      JSON.stringify({
        task: request.task,
        context: request.context,
        kind: request.kind,
        taskScope: request.checkpoint,
        folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
        capabilities: capabilities.workers,
        review: request.review ?? true,
        execution: {
          state: 'running',
          resumed: request.resumed ?? false,
          instruction: request.resumed
            ? 'The host invoked resume_task. Earlier temporary pause/await-resume instructions ' +
              'are satisfied. Execute the current assignment now; all other constraints remain.'
            : 'Execute the current assignment; lifecycle controls are managed by the host.',
        },
      }),
    )
    await refreshControls()
    combined.throwIfAborted()

    while (true) {
      await liveSession.settleGuidance()
      checkModelOutcome(session)

      if (worker.result() && (await live.mailbox.seal())) {
        break
      }

      await session.prompt(
        request.kind === 'branch'
          ? 'Continue autonomous implementation, repairs, checks and reviews within the design. ' +
              'Use submit_result when complete or genuinely blocked; do not ask for approval.'
          : 'Finish through submit_result, reporting remaining blockers honestly.',
      )
      await refreshControls()
      combined.throwIfAborted()
    }

    await worker.settle()
    combined.throwIfAborted()

    if (controlsError || !worker.result()) {
      throw new Error('Coordinator did not produce a result')
    }

    if (worker.result()!.verdict === 'pass') {
      await worker.validatePass()
    }

    const result = worker.result()

    if (!result) {
      throw new Error('Task controls changed before completion; a fresh result is required')
    }

    await live.finish(result.verdict === 'pass' ? 'complete' : 'needs_attention', result.summary)
    return {
      result,
      children: worker.children(),
      model: modelId,
      thinking: session.thinkingLevel,
      turns,
      controlRevision,
      ...(request.kind === 'branch' ? { checks: worker.checks() } : {}),
    }
  } catch (error) {
    await live.finish(combined.aborted ? 'cancelled' : 'failed', String(error))
    throw error
  } finally {
    clearInterval(controlsTimer)
    combined.removeEventListener('abort', abort)
    controller.abort()
    await poll
    await session.abort()
    await worker.settle()
    session.dispose()
    await liveSession.dispose()
    await worker.progress.settle()
    await modelRuntime.settleCredentialWrites()
  }
}
