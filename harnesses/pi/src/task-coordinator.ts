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
  auditResultSchema,
  resultSchema,
  thinkingSchema,
  ProviderQuotaError,
  completedResult,
  validateResult,
  writePathSchema,
  type ImplementerModel,
  type Checkpoint,
  type Project,
  type Receipt,
  type WorkerEvidence,
  type WorkerResult,
  type Role,
} from './contracts.ts'
import { dispatcher, type Dispatcher } from './dispatch.ts'
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
import { progressReporter, type TaskProgress } from './progress.ts'
import { workerCapabilities } from './capabilities.ts'
import { storedExecution } from './worker-execution.ts'
import { invariant } from './invariant.ts'
import {
  ActiveSiblings,
  dispatchSwarm,
  duplicateIds,
  researcherIdPattern,
  swarmReport,
  type SwarmOutcome,
  type SwarmReport,
} from './coordinator-swarm.ts'
import { LiveWorker } from './worker-live.ts'
import { attachLiveSession } from './worker-live-session.ts'

export interface TaskCoordinatorRequest {
  implementerModel?: ImplementerModel
  thinking?: Role['thinking']
  task: string
  context: string
  kind: 'documents' | 'research' | 'maintenance' | 'branch'
  decideContinuation?: boolean
  designPath?: string
  workspace: string
  project: Project
  checkpoint: Checkpoint
  model: string
  outputPath: string
  baseline: Record<string, string>
  originals: string
  controlsPath?: string
  resumed?: boolean
}

/** Only the host supplies the pinned path and its authored-file inventory. */
export function designReference(path: string, baseline: Record<string, string>) {
  const directory = dirname(path)
  const pathPrefix = directory === '.' ? '' : directory + '/'
  const nearbyDocuments: string[] = []

  for (const name of Object.keys(baseline)) {
    if (name !== path && name.startsWith(pathPrefix) && documentPath(name)) {
      nearbyDocuments.push(name)

      if (nearbyDocuments.length > 24) {
        return { path, pathPrefix }
      }
    }
  }

  nearbyDocuments.sort()
  return Buffer.byteLength(JSON.stringify(nearbyDocuments)) <= 1200
    ? { path, nearbyDocuments }
    : { path, pathPrefix }
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

const researcherSchema = Type.Object(
  {
    id: Type.String({ pattern: researcherIdPattern }),
    thinking: Type.Optional(thinkingSchema),
    task: Type.String({ minLength: 1, maxLength: 16000 }),
  },
  { additionalProperties: false },
)

const delegateSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('task-worker'),
      Type.Literal('implementer'),
      Type.Literal('performance'),
    ]),
    thinking: Type.Optional(thinkingSchema),
    task: Type.String({ minLength: 1, maxLength: 16000 }),
    writePaths: Type.Array(writePathSchema, { maxItems: 50 }),

    // A research swarm. The coordinator chooses this finite group, so no fixed size applies:
    // nothing is queued, and a researcher beyond actual capacity fails explicitly by id.
    researchers: Type.Optional(Type.Array(researcherSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
)

type DelegateRequest = Static<typeof delegateSchema>
type Delegation = Omit<DelegateRequest, 'researchers'> & {

  /** Set on swarm members: the researcher's identity and the brief its siblings share. */
  researcher?: { id: string; brief: string }
}
type ChildReceipt = { assignment: Delegation; evidence: WorkerEvidence }
type Researcher = { id: string; assignment: Delegation; role: Role; quotaKey: string }
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

/** Role and scope identify a leaf. Swarm researchers share both, so their id is part of the
 * identity: a sibling can neither clear another researcher's findings nor hide its failure. */
function assignmentKey(raw: Delegation): string {
  return JSON.stringify([raw.role, [...raw.writePaths].sort(), raw.researcher?.id ?? null])
}

function sameAssignment(left: Delegation, right: Delegation): boolean {
  return assignmentKey(left) === assignmentKey(right)
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

    if (!writable(path, assignment.writePaths) || !writable(path, allowed)) {
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
  const originals =
    request.kind === 'branch' || request.kind === 'maintenance'
      ? await inventory(request.originals)
      : undefined
  const coordinator = new Coordinator(request, signal, dispatch, role, originals)
  const worker = createWorkerTools({ ...request, role: 'progress-auditor' }, role)
  const tools: ToolDefinition[] = worker.tools
    .filter((tool) => tool.name !== 'submit_result')
    .map((tool) => ({
      ...tool,
      execute: (...args: Parameters<ToolDefinition['execute']>) =>
        coordinator.serialize(() => tool.execute(args[0], args[1], signal, args[3], args[4])),
    }))
  tools.push(milestoneTool(coordinator))

  if (request.kind === 'branch') {
    tools.push(runChecksTool(coordinator))
  }

  tools.push(delegateTool(coordinator), submitTool(coordinator))
  return {
    tools,
    children: () => coordinator.receipts.map((receipt) => receipt.evidence),
    checks: () => coordinator.checks,
    result: () => coordinator.submitted,
    invalidateResult: () => coordinator.invalidateResult(),
    settle: () => coordinator.settle(),
    validatePass: () => coordinator.validatePass(),
    progress: coordinator.progress,
  }
}

/** One coordinator run: its child receipts, check results and submission state. Child runs and
 * tool calls are serialized so each sees a stable candidate. A research swarm is one such
 * serialized step whose read-only researchers overlap only with each other. */
class Coordinator {
  readonly progress: ReturnType<typeof progressReporter>
  readonly receipts: ChildReceipt[] = []
  readonly performanceReview: boolean
  checks: Receipt[] = []
  submitted: WorkerResult | undefined
  submitting = false
  pending = 0
  revision = 0
  private checkedDatabase = false
  private declaredDatabase: boolean
  private fatal: unknown
  private readonly failedAssignments = new Map<string, Delegation>()
  private readonly rejectedModels = new Map<string, ProviderQuotaError>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly request: TaskCoordinatorRequest,
    readonly signal: AbortSignal,
    private readonly dispatch: Dispatcher,
    readonly role: Role,
    readonly originals: Map<string, Buffer> | undefined,
  ) {
    this.progress = progressReporter(request.outputPath, role.name)
    this.declaredDatabase = request.checkpoint.database
    this.performanceReview = request.checkpoint.performanceReview === true
  }

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      this.signal.throwIfAborted()
      return action()
    })
    this.queue = next.catch(() => {})
    return next
  }

  async settle() {
    await this.queue
  }

  invalidateResult() {
    this.submitted = undefined
    this.rejectedModels.clear()
    this.revision++
  }

  declareDatabase(impact: boolean) {
    this.declaredDatabase ||= impact
  }

  requireValidCandidate() {
    if (this.fatal) {
      throw new Error(
        `Previous failed child execution invalidated this candidate: ${String(this.fatal)}. ` +
          'Submit blocked with the cause and retained evidence so the host can recover.',
      )
    }
  }

  /** A request is one leaf, or one group of read-only researchers sharing a role and brief. */
  validateAssignments(raw: unknown): Delegation[] {
    if (!Check(delegateSchema, raw)) {
      throw new Error('Invalid leaf assignment')
    }

    if (this.submitted || this.submitting) {
      throw new Error('Task is already submitted')
    }

    const { researchers, ...leaf } = raw

    if (!researchers) {
      return [this.routeAssignment(leaf)]
    }

    if (leaf.role === 'performance') {
      throw new Error(
        'A research swarm takes task-worker or implementer researchers. A measurement runs alone',
      )
    }

    if (leaf.writePaths.length) {
      throw new Error(
        'A research swarm is read-only: assign empty writePaths and delegate each writer alone',
      )
    }

    const repeated = duplicateIds(researchers.map((researcher) => researcher.id))

    if (repeated.length) {
      throw new Error(`Researcher ids must be unique within a swarm: ${repeated.join(', ')}`)
    }

    const shared = this.routeAssignment(leaf)
    return researchers.map((researcher) => ({
      ...shared,
      task: researcher.task,
      thinking: researcher.thinking ?? shared.thinking,
      researcher: { id: researcher.id, brief: leaf.task },
    }))
  }

  private routeAssignment(raw: Delegation): Delegation {
    const { request } = this

    if (
      request.implementerModel &&
      raw.role === 'task-worker' &&
      (request.kind === 'research' || request.kind === 'documents')
    ) {
      return this.validateSelectedAssignment({ ...raw, role: 'implementer' })
    }

    return this.validateSelectedAssignment(raw)
  }

  private validateSelectedAssignment(raw: Delegation): Delegation {
    const { request } = this

    if (request.implementerModel && raw.role === 'task-worker' && raw.writePaths.length) {
      throw new Error('Assign implementation writes to the user-selected implementer')
    }

    if (raw.role === 'performance' && !this.performanceReview) {
      throw new Error('Performance review requires an explicit user request')
    }

    if (!scopeContained(raw.writePaths, request.checkpoint.writePaths)) {
      throw new Error('Child write scope exceeds the delegated task')
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

  /** Run one child serially and record its receipt before the next tool call. */
  async delegate(assignment: Delegation): Promise<WorkerEvidence> {
    invariant(!assignment.researcher, 'a swarm researcher runs with its group')
    this.pending++

    try {
      return await this.serialize(async () => {
        this.requireValidCandidate()
        const before = await inventory(this.request.workspace)
        const completed = await this.runChild(
          assignment,
          before,
          this.originals && changes(this.originals, before),
        )

        try {
          await atomicJson(`${this.request.outputPath}.children.json`, [
            ...this.receipts,
            completed,
          ])
        } catch (error) {
          this.fatal = error
          throw error
        }

        this.receipts.push(completed)
        const { evidence } = completed
        await this.progress.update({
          stage: 'coordinating',
          role: this.role.name,
          message:
            evidence.role +
            ': ' +
            evidence.result.verdict +
            '. ' +
            evidence.result.summary.slice(0, 200),
        })
        return evidence
      })
    } finally {
      this.pending--
    }
  }

  /** A child failure that left valid writes is recoverable; anything else invalidates the
   * candidate for the rest of this run. */
  private async runChild(
    raw: Delegation,
    before: Map<string, Buffer>,
    changedFiles: string[] | undefined,
  ): Promise<ChildReceipt> {
    const failure = { recoverable: false }

    try {
      const implementerModel =
        raw.role === 'implementer' ? this.request.implementerModel : undefined
      const childRole = await loadRole(raw.role, raw.thinking, implementerModel)
      await this.progress.update({
        stage: 'child',
        role: raw.role,
        child: undefined,
        message: raw.task.slice(0, 240),
      })
      const child = await this.dispatchChild(raw, childRole, before, changedFiles, failure)
      this.signal.throwIfAborted()
      const after = await inventory(this.request.workspace)
      checkChildEvidence(this.request, raw, childRole, child, after)
      checkChildWrites(this.request, raw, childRole, before, after)
      this.failedAssignments.delete(assignmentKey(raw))
      return { assignment: raw, evidence: child }
    } catch (error) {
      if (!failure.recoverable && !this.fatal) {
        this.fatal = error
      }

      await this.progress.update({ stage: 'issue', message: String(error).slice(0, 500) })
      throw error
    }
  }

  private async dispatchChild(
    raw: Delegation,
    childRole: Role,
    before: Map<string, Buffer>,
    changedFiles: string[] | undefined,
    failure: { recoverable: boolean },
  ): Promise<WorkerEvidence> {
    const { request } = this
    const quotaKey = this.quotaKey(raw, childRole)

    try {
      const rejected = this.rejectedModels.get(quotaKey)

      if (rejected && rejected.retryAt > Date.now()) {
        throw rejected
      }

      return await this.dispatch(this.childRequest(raw, changedFiles), this.signal, (activity) =>
        this.progress.update({ stage: 'child', role: raw.role, child: activity }),
      )
    } catch (error) {
      checkChildWrites(request, raw, childRole, before, await inventory(request.workspace))

      if (error instanceof ProviderQuotaError) {
        this.rejectedModels.set(quotaKey, error)
      }

      failure.recoverable = true
      this.failedAssignments.set(assignmentKey(raw), raw)
      throw error
    }
  }

  private quotaKey(raw: Delegation, childRole: Role): string {
    return raw.role === 'implementer' && this.request.implementerModel
      ? 'implementer/' + childRole.model
      : childRole.model
  }

  private childRequest(
    raw: Delegation,
    changedFiles: string[] | undefined,
  ): Parameters<Dispatcher>[0] {
    const { request } = this
    const implementerModel = raw.role === 'implementer' ? request.implementerModel : undefined
    return {
      role: raw.role,
      thinking: raw.thinking,
      implementerModel,
      documentsOnly:
        (request.kind === 'documents' && Boolean(implementerModel)) ||
        (request.kind === 'branch' && raw.role === 'task-worker'),
      task: this.childTask(raw),
      workspace: request.workspace,
      project: request.project,
      checkpoint: { ...request.checkpoint, writePaths: raw.writePaths },
      model: request.model,
      baseline: request.baseline,
      originals: request.originals,
      changedFiles,
    }
  }

  /** Run a finite group of read-only researchers together. The group holds the candidate
   * exclusively, so writers, checks and inspection wait until every researcher has settled. */
  async delegateSwarm(members: Delegation[]): Promise<SwarmReport<WorkerEvidence>> {
    this.pending++

    try {
      return await this.serialize(() => this.runSwarm(members))
    } finally {
      this.pending--
    }
  }

  /** A researcher's own failure is recoverable and reported by id. A changed candidate,
   * mismatched evidence or a lost receipt invalidates the candidate for the rest of this run. */
  private async runSwarm(members: Delegation[]): Promise<SwarmReport<WorkerEvidence>> {
    this.requireValidCandidate()
    const failure = { recoverable: false }

    try {
      const before = await inventory(this.request.workspace)
      const researchers = await this.prepareResearchers(members)
      const outcomes = await this.dispatchResearchers(researchers, before, failure)
      const completed = await this.acceptResearchers(researchers, outcomes, before)
      return await this.recordResearchers(completed, outcomes)
    } catch (error) {
      if (!failure.recoverable && !this.fatal) {
        this.fatal = error
      }

      await this.progress.update({ stage: 'issue', message: String(error).slice(0, 500) })
      throw error
    }
  }

  /** Resolve every role before any researcher starts, so starting needs no further waiting. */
  private async prepareResearchers(members: Delegation[]): Promise<Researcher[]> {
    const researchers: Researcher[] = []

    for (const assignment of members) {
      invariant(
        assignment.researcher && !assignment.writePaths.length,
        'swarm members are read-only researchers',
      )
      const role = await loadRole(
        assignment.role,
        assignment.thinking,
        assignment.role === 'implementer' ? this.request.implementerModel : undefined,
      )
      researchers.push({
        id: assignment.researcher.id,
        assignment,
        role,
        quotaKey: this.quotaKey(assignment, role),
      })
    }

    return researchers
  }

  private async dispatchResearchers(
    researchers: Researcher[],
    before: Map<string, Buffer>,
    failure: { recoverable: boolean },
  ): Promise<SwarmOutcome<WorkerEvidence>[]> {
    const changedFiles = this.originals && changes(this.originals, before)
    const siblings = new ActiveSiblings<TaskProgress>()
    const ids = researchers.map((researcher) => researcher.id).join(', ')
    await this.progress.update({
      stage: 'child',
      role: researchers[0]?.assignment.role,
      child: undefined,
      message: `Research swarm of ${researchers.length}: ${ids}`.slice(0, 240),
    })

    try {
      return await dispatchSwarm(
        researchers,
        (researcher) => this.runResearcher(researcher, changedFiles, siblings, researchers.length),
        this.signal,
      )
    } catch (error) {

      // Cancellation ends a swarm after every researcher stopped. None has a receipt, so each
      // stays outstanding; an edited candidate is a violation and not a recoverable stop.
      this.requireUnchanged(before, await inventory(this.request.workspace))

      for (const { assignment } of researchers) {
        this.failedAssignments.set(assignmentKey(assignment), assignment)
      }

      failure.recoverable = this.signal.aborted
      throw error
    }
  }

  /** One researcher. Its dispatch call precedes the first await, so dispatchSwarm starts the
   * whole group in one pass. Progress is keyed by researcher id, never by the shared role. */
  private async runResearcher(
    researcher: Researcher,
    changedFiles: string[] | undefined,
    siblings: ActiveSiblings<TaskProgress>,
    total: number,
  ): Promise<WorkerEvidence> {
    const { id, assignment, quotaKey } = researcher
    const role = assignment.role
    siblings.start(id, { stage: 'starting', role, updatedAt: new Date().toISOString() })

    try {
      const rejected = this.rejectedModels.get(quotaKey)

      if (rejected && rejected.retryAt > Date.now()) {
        throw rejected
      }

      return await this.dispatch(
        this.childRequest(assignment, changedFiles),
        this.signal,
        async (activity) => {
          if (siblings.update(id, activity)) {
            await this.progress.update({ stage: 'child', role, child: activity })
          }
        },
      )
    } finally {
      siblings.finish(id)
      await this.progress.update({
        stage: 'child',
        role,
        child: siblings.current(),
        message: `Research swarm: ${total - siblings.size} of ${total} settled`,
      })
    }
  }

  private requireUnchanged(before: Map<string, Buffer>, after: Map<string, Buffer>) {
    const [edited] = changes(before, after)

    if (edited !== undefined) {
      throw new Error(`Read-only research swarm changed the candidate: ${edited}`)
    }
  }

  /** Validate each settled researcher against the unchanged candidate. Failed researchers stay
   * outstanding under their own identity until that id is dispatched again and completes. */
  private async acceptResearchers(
    researchers: Researcher[],
    outcomes: SwarmOutcome<WorkerEvidence>[],
    before: Map<string, Buffer>,
  ): Promise<ChildReceipt[]> {
    invariant(outcomes.length === researchers.length, 'each researcher has exactly one outcome')
    const after = await inventory(this.request.workspace)
    this.requireUnchanged(before, after)
    const completed: ChildReceipt[] = []

    for (const [index, outcome] of outcomes.entries()) {
      const { id, assignment, role, quotaKey } = researchers[index]!
      invariant(outcome.id === id, 'outcomes keep researcher order')

      if (outcome.status === 'completed') {
        checkChildEvidence(this.request, assignment, role, outcome.value, after)
        completed.push({ assignment, evidence: outcome.value })
        continue
      }

      if (outcome.error instanceof ProviderQuotaError) {
        this.rejectedModels.set(quotaKey, outcome.error)
      }

      this.failedAssignments.set(assignmentKey(assignment), assignment)
    }

    const workers = completed.flatMap(({ evidence }) => evidence.liveWorkerId ?? [])

    if (duplicateIds(workers).length) {
      throw new Error('Stale or mismatched child evidence: researchers share a worker identity')
    }

    return completed
  }

  /** Persist one receipt per completed researcher in group order, then report every outcome. */
  private async recordResearchers(
    completed: ChildReceipt[],
    outcomes: SwarmOutcome<WorkerEvidence>[],
  ): Promise<SwarmReport<WorkerEvidence>> {
    const recorded = this.receipts.length
    await atomicJson(`${this.request.outputPath}.children.json`, [...this.receipts, ...completed])
    this.receipts.push(...completed)
    invariant(
      this.receipts.length === recorded + completed.length,
      'each completed researcher adds exactly one receipt',
    )

    for (const { assignment } of completed) {
      this.failedAssignments.delete(assignmentKey(assignment))
    }

    const report = swarmReport(outcomes)
    const { size, failed, capacityFailures } = report.swarm
    await this.progress.update({
      stage: 'coordinating',
      role: this.role.name,
      message:
        `Research swarm: ${completed.length} of ${size} completed` +
        (failed ? `, ${failed} failed (${capacityFailures} for capacity)` : ''),
    })
    return report
  }

  private childTask(raw: Delegation) {
    const { request } = this
    return JSON.stringify({
      task: raw.task,
      ...(raw.researcher && {
        research: {
          researcher: raw.researcher.id,
          sharedBrief: raw.researcher.brief,
          access:
            'Read-only. Sibling researchers work on the same candidate at the same time. ' +
            'Report findings; retain no edits.',
        },
      }),
      parentTask: request.task,
      context: request.context,
      kind: request.kind,
      capabilities: workerCapabilities(storedExecution(request.project.execution).mode),
      execution: { state: 'running', resumed: request.resumed ?? false },
      authority:
        request.kind === 'branch'
          ? 'Authorized design-document implementation; repair verified failures.'
          : 'Bounded task scope; this is not an accepted implementation design.',
      previousFindings: this.receipts
        .filter((receipt) => sameAssignment(receipt.assignment, raw))
        .map((receipt) => receipt.evidence.result),
    })
  }

  async needsDatabaseChecks(): Promise<boolean> {
    return (
      this.declaredDatabase ||
      this.receipts.some((entry) => entry.evidence.result.databaseImpact) ||
      Boolean(
        this.originals &&
        databaseImpact(
          this.originals,
          await inventory(this.request.workspace),
          this.request.project.databasePaths,
        ),
      )
    )
  }

  /** Branch tools: run required checks, harness lint and benchmarks on the candidate. */
  async runChecks() {
    const { request, signal } = this

    if (this.submitted || this.submitting) {
      throw new Error('Task is already submitted')
    }

    this.requireValidCandidate()
    this.checks = []
    this.checkedDatabase = false
    this.checkedDatabase = await this.needsDatabaseChecks()
    this.checks = await verifyProject(
      request.workspace,
      request.project,
      this.checkedDatabase,
      signal,
      { files: this.originals!, writePaths: request.checkpoint.writePaths },
    )

    if (this.measuresPerformance()) {
      this.checks.push(...(await benchmarks(request.workspace, request.project, signal)))
    }

    await atomicJson(`${request.outputPath}.checks.json`, this.checks)
    return { database: this.checkedDatabase, checks: this.checks.map(receiptView) }
  }

  private measuresPerformance() {
    return (
      this.request.checkpoint.performance ||
      this.receipts.some((receipt) => receipt.evidence.role === 'performance')
    )
  }

  private async validateBranch(snapshot: string): Promise<void> {
    const database = await this.needsDatabaseChecks()
    const performance = this.measuresPerformance()
    const checks = this.checks
    const required = [
      'harness-lint',
      ...this.request.project.checks
        .filter((check) => check.required && (check.kind !== 'benchmark' || performance))
        .map((check) => check.id),
    ]

    if (
      !checks.length ||
      (database && !this.checkedDatabase) ||
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

  checkSelectedEvidence(snapshot: string) {
    const { kind, implementerModel } = this.request

    if (!implementerModel || (kind !== 'research' && kind !== 'documents')) {
      return
    }

    const latest = this.receipts.findLast(({ assignment }) => assignment.role === 'implementer')

    if (
      !latest ||
      latest.evidence.snapshot !== snapshot ||
      !completedResult(latest.evidence.result.verdict, kind === 'research')
    ) {
      throw new Error('Delegate the scoped task to the selected implementer before completion')
    }
  }

  checkPerformanceEvidence(snapshot: string) {
    if (!this.performanceReview) {
      return
    }

    const child = this.receipts.findLast((entry) => entry.evidence.role === 'performance')?.evidence

    if (
      !child ||
      child.snapshot !== snapshot ||
      !completedResult(child.result.verdict, this.request.kind === 'research')
    ) {
      throw new Error(
        'Completion requires the requested performance evidence on the final candidate',
      )
    }
  }

  async validatePass(): Promise<void> {
    this.signal.throwIfAborted()
    this.requireValidCandidate()

    if (this.pending || this.failedAssignments.size) {
      const researchers = [...this.failedAssignments.values()].flatMap(
        (assignment) => assignment.researcher?.id ?? [],
      )
      throw new Error(
        'Unfinished or failed child execution prevents a passing result' +
          (researchers.length ? `. Unfinished researchers: ${researchers.join(', ')}` : ''),
      )
    }

    const snapshot = snapshotHash(await inventory(this.request.workspace))
    this.checkSelectedEvidence(snapshot)
    this.checkPerformanceEvidence(snapshot)
    requireResolvedFindings(this.receipts, snapshot)

    if (this.request.kind === 'branch') {
      await this.validateBranch(snapshot)
    }
  }
}

/** Each non-passing child assignment must have a later pass for the same role and scope on the
 * final snapshot. */
function requireResolvedFindings(receipts: ChildReceipt[], snapshot: string) {
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.evidence.result.verdict === 'pass') {
      continue
    }

    const latest = receipts
      .slice(index)
      .findLast((candidate) => sameAssignment(receipt.assignment, candidate.assignment))!

    if (latest.evidence.result.verdict !== 'pass' || latest.evidence.snapshot !== snapshot) {
      throw new Error(
        'Resolve child findings on the final snapshot. ' +
          'Outstanding assignment: ' +
          JSON.stringify({
            role: receipt.assignment.role,
            writePaths: receipt.assignment.writePaths,
            researcher: receipt.assignment.researcher?.id,
            verdict: latest.evidence.result.verdict,
            snapshotMatches: latest.evidence.snapshot === snapshot,
          }) +
          (receipt.assignment.researcher
            ? '. Dispatch this researcher id again with the same role to resolve its prior ' +
              'findings. A sibling researcher or a separate leaf does not clear it.'
            : '. Delegate this exact role and writePaths to resolve its prior findings. ' +
              'A read-only follow-up with different writePaths does not clear this assignment. ' +
              'Keep the same scope even if no edits are needed.'),
      )
    }
  }
}

/** Child evidence must match the candidate bytes, its configured model and its telemetry. */
function checkChildEvidence(
  request: TaskCoordinatorRequest,
  raw: Delegation,
  childRole: Role,
  child: WorkerEvidence,
  after: Map<string, Buffer>,
) {
  if (child.role !== raw.role || child.snapshot !== snapshotHash(after)) {
    throw new Error('Stale or mismatched child evidence')
  }

  validateResult(child.result)
  const expectedModel = childRole.model === 'inherit' ? request.model : childRole.model
  const actualModel =
    childRole.backend === 'claude-cli' ? child.model.replace(/^claude-cli\//, '') : child.model
  const validFallback =
    childRole.backend === 'claude-cli' &&
    expectedModel === 'claude-fable-5-2' &&
    (raw.role !== 'implementer' || child.thinking === childRole.thinking) &&
    child.quotaFallbackFrom === expectedModel &&
    /^claude-cli\/claude-opus-/.test(child.model)

  // Fallback provenance is valid only on an actual Fable-to-Opus fallback. A claim on any other
  // receipt would attribute the work to a model selection that never happened.
  const claimedFallback = child.quotaFallbackFrom !== undefined

  if ((actualModel !== expectedModel || claimedFallback) && !validFallback) {
    throw new Error('Child model does not match its configured role')
  }

  if (!Number.isSafeInteger(child.turns) || child.turns < 1) {
    throw new Error('Invalid child turn telemetry')
  }
}

function milestoneTool(coordinator: Coordinator): ToolDefinition {
  return {
    name: 'report_milestone',
    label: 'Report a project milestone',
    description:
      'Flag a verified outcome or material change of plan for the host. Summarize the current ' +
      'outcome, evidence and impact in one or two sentences. Routine progress stays private.',
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 400 }) }),
    async execute(_id, raw) {
      const { summary } = raw as { summary: string }
      return coordinator.serialize(async () => {
        if (coordinator.submitted || coordinator.submitting || !summary.trim()) {
          throw new Error('An active task and a concrete milestone are required')
        }

        await coordinator.progress.update({ milestone: summary.trim() })
        return textResult({ recorded: true })
      })
    },
  }
}

function runChecksTool(coordinator: Coordinator): ToolDefinition {
  return {
    name: 'run_checks',
    label: 'Run branch acceptance checks',
    description:
      'Run the configured required tests, lint, recovery checks and benchmarks. ' +
      'Harness lint and host checks run after sandbox checks pass. inheritedLintPaths are ' +
      'existing base findings and never block. Repair failures and rerun after edits.',
    parameters: Type.Object({}),
    async execute() {
      coordinator.pending++

      try {
        return textResult(await coordinator.serialize(() => coordinator.runChecks()))
      } finally {
        coordinator.pending--
      }
    },
  }
}

function delegateTool(coordinator: Coordinator): ToolDefinition {
  return {
    name: 'delegate_worker',
    label: 'Delegate bounded leaf task',
    description:
      'Choose thinking for this leaf: low for mechanical tasks, medium for settled designs, ' +
      'high for unresolved tradeoffs or tricky repairs. Fable specialists support medium/high. ' +
      'Use a performance specialist only on explicit user request. ' +
      'For independent read-only research, pass researchers with empty writePaths: task is ' +
      'their shared brief, each researcher has a unique id and its own task, all start ' +
      'together, and one call returns an outcome per id. Nothing is queued: redispatch the ' +
      'ids listed as unfinished. Writers and checks always run alone.',
    parameters: delegateSchema,
    async execute(_id, raw) {
      const children = coordinator.validateAssignments(raw)

      for (const child of children) {
        if (child.thinking !== undefined) {
          await loadRole(
            child.role,
            child.thinking,
            child.role === 'implementer' ? coordinator.request.implementerModel : undefined,
          )
        }
      }

      const [leaf] = children
      invariant(leaf, 'a validated request has at least one assignment')
      return textResult(
        leaf.researcher
          ? await coordinator.delegateSwarm(children)
          : await coordinator.delegate(leaf),
      )
    },
  }
}

function submitTool(coordinator: Coordinator): ToolDefinition {
  const { request, signal } = coordinator
  return {
    name: 'submit_result',
    label: 'Submit coordinated task result',
    description: 'Submit only after all children finish and required findings are resolved.',
    parameters: request.decideContinuation ? auditResultSchema : resultSchema,
    async execute(_id, raw) {
      signal.throwIfAborted()

      if (coordinator.pending || coordinator.submitting) {
        throw new Error('Wait for all child workers before submitting')
      }

      const result = validateResult(raw, request.decideContinuation)
      coordinator.declareDatabase(result.databaseImpact)
      const submittedRevision = coordinator.revision
      coordinator.submitting = true

      try {
        if (result.verdict === 'pass') {
          await coordinator.validatePass()
        } else if (
          (request.implementerModel || coordinator.performanceReview) &&
          completedResult(result.verdict, request.kind === 'research')
        ) {
          const snapshot = snapshotHash(await inventory(request.workspace))
          coordinator.checkSelectedEvidence(snapshot)
          coordinator.checkPerformanceEvidence(snapshot)
        }

        if (submittedRevision !== coordinator.revision) {
          throw new Error('Task controls changed; submit a fresh result after applying them')
        }

        coordinator.submitted = result
        await coordinator.progress.update({
          stage: result.verdict === 'blocked' ? 'blocked' : 'complete',
          message: result.summary,
          child: undefined,
        })
        return textResult({ submitted: true })
      } finally {
        coordinator.submitting = false
      }
    },
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
      const review = child.role === 'performance'
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
    resourceLoader: await explicitResources(await rolePrompt(coordinatorRole(request))),
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
        implementerModel: request.implementerModel,
        ...(request.kind === 'branch' &&
          request.designPath && {
            pinnedDesign: designReference(request.designPath, request.baseline),
          }),
        folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
        capabilities: workerCapabilities(storedExecution(request.project.execution).mode),
        commandExecution: storedExecution(request.project.execution),
        performanceReview: request.checkpoint.performanceReview === true,
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
          ? 'Continue implementation and repairs. Finish when the required checks pass. ' +
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

    const completed = completedResult(result.verdict, request.kind === 'research')
    await live.finish(completed ? 'complete' : 'needs_attention', result.summary)
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
