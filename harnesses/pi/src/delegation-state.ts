import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { StateStore, atomicJson, readJson } from './state.ts'
import { acquireLock } from './lock.ts'
import { matches, validateWriteScope } from './paths.ts'
import type { Receipt, WorkerEvidence } from './contracts.ts'
import {
  implementerModelSchema,
  taskTitleSchema,
  thinkingSchema,
  workflowSpecialistsSchema,
  designSchema,
  validateDesign,
  writePathSchema,
} from './contracts.ts'
import type { BranchPlan, BranchTaskInput } from './branch-contracts.ts'
import { readProgress, type TaskProgress } from './progress.ts'
import { hostCapability } from './capabilities.ts'
import type { WorkerResult } from './contracts.ts'
import { recoverTaskRevision } from './task-recovery.ts'

export const delegateSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 8000 }),
    context: Type.String({ maxLength: 24000 }),
    title: Type.Optional(taskTitleSchema),
    implementerModel: Type.Optional(implementerModelSchema),
    thinking: Type.Optional(thinkingSchema),
    specialistThinking: Type.Optional(workflowSpecialistsSchema),
    kind: Type.Union([
      Type.Literal('documents'),
      Type.Literal('research'),
      Type.Literal('maintenance'),
      Type.Literal('implementation'),
    ]),
    writePaths: Type.Array(writePathSchema, { maxItems: 30 }),
    requires: Type.Optional(Type.Array(hostCapability, { maxItems: 4 })),
    design: Type.Optional(designSchema),
    review: Type.Optional(
      Type.Boolean({
        description: 'False only for routine low-risk maintenance; substantive code needs review.',
      }),
    ),
  },
  { additionalProperties: false },
)
export type DelegateInput = Static<typeof delegateSchema>
export type DelegationRequest = Omit<DelegateInput, 'kind'> & {
  kind: DelegateInput['kind'] | 'branch'
  branch?: BranchPlan
  id: string
  root: string
  session: string
  originEntry?: string
  model: string
  createdAt: string
  recurring?: {
    name: string
    audit: boolean
    model?: 'codex' | 'fable'
    reportDirectory?: string
    stopWhen?: string
  }
  checkpointHash?: string
}
export type DelegationStatus = {
  id: string
  status:
    | 'queued'
    | 'running'
    | 'checking'
    | 'applying'
    | 'publishing'
    | 'merge_queued'
    | 'merging'
    | 'published'
    | 'complete'
    | 'needs_attention'
    | 'cancelled'
    | 'failed'
    | 'paused'
  updatedAt: string
  pid?: number
  candidate?: string
  summary?: string
  error?: string
  changedPaths?: string[]
  workflowTaskId?: string
  receiptAttempt?: string
  receipts?: Receipt[]
  children?: {
    role: string
    model: string
    verdict: string
    snapshot?: string
    testingScore?: number | null
    closedReview?: WorkerEvidence['closedReview']
  }[]
  branch?: string
  base?: string
  commit?: string
  pullRequest?: string
  mergeBase?: string
  mergeAttempts?: number
  deliveryVersion?: number
  mergeRequested?: boolean
  progress?: TaskProgress
  activityAgeMs?: number
  health?: 'active' | 'quiet' | 'stopped' | 'needs_attention'
  auditReport?: string
  auditRequired?: Pick<WorkerResult['findings'][number], 'location' | 'problem'>[]
  auditAttention?: boolean
  auditDecision?: WorkerResult['continuation']
  progressFile?: string
  hostActions?: WorkerResult['hostActions']
}
export type Delegation = { request: DelegationRequest; state: DelegationStatus; milestone?: string }
export type TaskControls = {
  previousHostHandoff?: {
    forDeliveryVersion: number
    attempt: string
    actions: NonNullable<WorkerResult['hostActions']>
  }
  revision: number
  baseRevision?: number
  messages: { revision: number; text: string }[]
  cancelled: boolean
  mergeRequested?: boolean
  mergeRequestId?: string
  paused?: boolean
}

export function handoffForResume(job: Delegation, controls: TaskControls) {
  if (job.request.kind !== 'branch') {
    return undefined
  }

  const forDeliveryVersion = (job.state.deliveryVersion ?? 0) + 1

  if (job.state.progressFile && job.state.hostActions?.length) {
    return { forDeliveryVersion, attempt: job.state.progressFile, actions: job.state.hostActions }
  }

  if (controls.previousHostHandoff?.forDeliveryVersion === forDeliveryVersion) {
    return controls.previousHostHandoff
  }

  return undefined
}

export const emptyControls: TaskControls = { revision: 0, messages: [], cancelled: false }
const activeStates = new Set([
  'queued',
  'running',
  'checking',
  'applying',
  'publishing',
  'merge_queued',
  'merging',
])
export type DelegationOrigin = { session: string; originEntry?: string; model: string }

export function activeTask(state: DelegationStatus): boolean {
  return activeStates.has(state.status)
}

export function ownsTaskPaths(state: DelegationStatus): boolean {
  return activeTask(state) || state.status === 'paused'
}

function retainedJobs(previous: Delegation[], added: number): Delegation[] {
  const owners = previous.filter((job) => ownsTaskPaths(job.state))
  const available = 200 - added - owners.length

  if (available < 0) {
    throw new Error('Task registry is full; resolve paused tasks before adding more')
  }

  const completed = previous.filter((job) => !ownsTaskPaths(job.state))
  return owners.concat(available ? completed.slice(-available) : [])
}

export function delegationDirectory(store: StateStore, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) {
    throw new Error('Invalid delegated task ID')
  }

  return join(store.directory, 'delegations', id)
}

function fold(path: string): string {
  return path
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) =>
    right.some((b) => {
      const first = fold(a)
      const second = fold(b)
      return (
        matches(first.replace(/\/\*\*$/, ''), second) ||
        matches(second.replace(/\/\*\*$/, ''), first)
      )
    }),
  )
}

export class DelegationBusy extends Error {}

function checkWriteReservations(request: DelegationRequest, previous: Delegation[]): void {
  if (!request.writePaths.length) {
    return
  }

  const owners = previous.filter(
    (job) =>
      ownsTaskPaths(job.state) &&
      (job.request.kind === 'branch') === (request.kind === 'branch') &&
      job.request.writePaths.length > 0,
  )
  const overlap = owners.find((job) => scopesOverlap(request.writePaths, job.request.writePaths))

  if (overlap) {
    throw new DelegationBusy(
      `Files already owned by task ${overlap.request.id} (${overlap.request.kind}, ` +
        `${overlap.state.status}). Inspect task_status before scheduling work on these paths.`,
    )
  }

  const writer = owners.find(
    (job) => request.kind === 'implementation' || job.request.kind === 'implementation',
  )

  if (writer) {
    throw new DelegationBusy(
      'The shared implementation workflow requires exclusive local writes. ' +
        `Task ${writer.request.id} (${writer.request.kind}, ${writer.state.status}) ` +
        'holds a reservation on different paths. Both workflow and implementation through ' +
        'delegate_task use the same checkpoint. Continue after the reservation is released, ' +
        'or use delegate_branches for new independent work with a committed design and checks.',
    )
  }
}

export function delegationView(job: Delegation) {
  const { receipts, ...state } = job.state
  return {
    kind: job.request.kind,
    ...(job.request.recurring && { schedule: job.request.recurring.name }),
    thinking: job.request.thinking,
    task: job.request.task.slice(0, 500),
    writePaths: job.request.writePaths,
    ...state,
    state: state.status,
    checks: receipts?.map((receipt) => ({
      check: receipt.check,
      status: receipt.status,
      snapshot: receipt.snapshot,
    })),
  }
}

export function validateDelegation(input: DelegateInput): void {
  if (!Check(delegateSchema, input)) {
    throw new Error('Invalid delegated task; provide task, context, kind and writePaths')
  }

  if (input.implementerModel && !['implementation', 'maintenance'].includes(input.kind)) {
    throw new Error('Select a Claude implementer for implementation or maintenance tasks')
  }

  if (input.implementerModel && input.kind === 'implementation' && input.thinking === 'low') {
    throw new Error('Claude implementers support medium or high effort')
  }

  validateWriteScope(input.writePaths)

  if (input.specialistThinking && input.kind !== 'implementation') {
    throw new Error('Specialist thinking overrides apply only to implementation workflows')
  }

  if (input.design && input.kind !== 'implementation') {
    throw new Error('A design is only valid for implementation tasks')
  }

  if (input.design) {
    validateWriteScope(input.design.writePaths)
  }

  if (input.requires?.length) {
    throw new Error(
      `Host capabilities required: ${input.requires.join(', ')}. ` +
        'Perform these authorized operations on the host; delegate only worker-compatible work.',
    )
  }

  if (input.kind === 'research' && input.writePaths.length) {
    throw new Error('Research tasks have no write scope')
  }

  if (input.kind === 'documents' && (!input.writePaths.length || input.writePaths.includes('**'))) {
    throw new Error('Document tasks need specific files or document directories')
  }
}

export class Delegations {
  constructor(readonly store: StateStore) {}

  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.store.directory, { recursive: true, mode: 0o700 })
    let release

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        release = await acquireLock(join(this.store.directory, 'delegations.lock'))
        break
      } catch (error) {
        if (!String(error).includes('already running') || attempt === 19) {
          throw error
        }

        await delay(25)
      }
    }

    if (!release) {
      throw new Error('Could not acquire delegated task registry')
    }

    try {
      await recoverTaskRevision(this.store)
      return await operation()
    } finally {
      await release()
    }
  }

  async get(id: string): Promise<Delegation> {
    const directory = delegationDirectory(this.store, id)
    const request = await readJson<DelegationRequest>(join(directory, 'request.json'))
    let state = await readJson<DelegationStatus>(join(directory, 'status.json'))

    if (!request || !state || request.id !== id || request.root !== this.store.projectRoot) {
      throw new Error('No delegated task with this ID in the project')
    }

    if (activeTask(state) && state.pid) {
      try {
        process.kill(state.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          state = {
            ...state,
            status: 'needs_attention',
            error: 'Task supervisor stopped; inspect retained candidate and integration evidence.',
          }
        }
      }
    }

    if (state.status === 'queued' && Date.now() - Date.parse(state.updatedAt) > 60000) {
      state = {
        ...state,
        status: 'failed',
        error: 'Task supervisor did not start within 60 seconds',
      }
    }

    const report = await readProgress(join(directory, state.progressFile ?? 'coordinator.json'))
    const milestone = report?.milestone
    const progress = report && { ...report, milestone: undefined }
    const activity = progress?.child?.updatedAt ?? progress?.updatedAt ?? state.updatedAt
    const activityAgeMs = Math.max(0, Date.now() - Date.parse(activity))
    state = {
      ...state,
      progress,
      activityAgeMs,
      health: activeTask(state)
        ? activityAgeMs > 180000
          ? 'quiet'
          : 'active'
        : state.status === 'needs_attention' || state.status === 'failed'
          ? 'needs_attention'
          : 'stopped',
    }
    return { request, state, milestone }
  }

  async list(): Promise<Delegation[]> {
    const ids =
      (await readJson<string[]>(join(this.store.directory, 'delegations', 'index.json'))) ?? []

    if (!Array.isArray(ids) || ids.length > 200) {
      throw new Error('Invalid delegated task index')
    }

    return Promise.all(ids.map((id) => this.get(id)))
  }

  async start(
    input: DelegateInput,
    origin: DelegationOrigin,
    launch: (request: DelegationRequest) => Promise<void>,
    recurring?: DelegationRequest['recurring'],
  ): Promise<Delegation> {
    validateDelegation(input)

    return this.locked(async () => {
      const checkpoint = input.kind === 'implementation' ? await this.store.checkpoint() : undefined
      const design = input.design ?? checkpoint

      if (input.kind === 'implementation' && (!design || design.unresolved.length)) {
        throw new Error('Supply a settled design to workflow; resolve blockers for this scope')
      }

      const request: DelegationRequest = {
        ...input,
        ...origin,
        ...(recurring && { recurring }),
        writePaths: design?.writePaths ?? input.writePaths,
        id: randomUUID(),
        root: this.store.projectRoot,
        createdAt: new Date().toISOString(),
        checkpointHash: checkpoint?.hash,
      }
      const previous = await this.list()
      const retained = retainedJobs(previous, 1)
      const active = previous.filter(
        (job) => activeTask(job.state) && job.request.kind !== 'branch',
      )

      checkWriteReservations(request, previous)

      if (active.length >= 2) {
        throw new DelegationBusy(
          'Two background tasks are active; finish or cancel one before starting more',
        )
      }

      if (input.design) {
        const release = await this.store.lock()

        try {
          release.assertHeld()
          request.checkpointHash = (await this.store.pin(input.design)).hash
        } finally {
          await release()
        }
      }

      const directory = delegationDirectory(this.store, request.id)
      const state: DelegationStatus = {
        id: request.id,
        status: 'queued',
        updatedAt: request.createdAt,
      }
      await atomicJson(join(directory, 'request.json'), request)
      await atomicJson(join(directory, 'controls.json'), emptyControls)
      await atomicJson(join(directory, 'status.json'), state)
      await atomicJson(join(this.store.directory, 'delegations', 'index.json'), [
        ...retained.map((job) => job.request.id),
        request.id,
      ])

      try {
        await launch(request)
      } catch (error) {
        await atomicJson(join(directory, 'status.json'), {
          ...state,
          status: 'failed',
          error: String(error),
          updatedAt: new Date().toISOString(),
        })
        throw error
      }

      return { request, state }
    })
  }

  async startBranches(
    inputs: BranchTaskInput[],
    origin: DelegationOrigin,
    launch: (request: DelegationRequest) => Promise<void>,
  ): Promise<Delegation[]> {
    if (!inputs.length || inputs.length > 4) {
      throw new Error('Provide one to four independent branch tasks')
    }

    for (const input of inputs) {
      validateDesign(input.branch.design)
      validateWriteScope(input.writePaths)

      if (
        input.branch.design.unresolved.length ||
        JSON.stringify(input.writePaths) !== JSON.stringify(input.branch.design.writePaths) ||
        input.branch.target !== 'main' ||
        !/^[a-f0-9]{40,64}$/.test(input.branch.base)
      ) {
        throw new Error('Branch tasks need a pinned main commit and settled scoped design')
      }
    }

    return this.locked(async () => {
      const previous = await this.list()
      const retained = retainedJobs(previous, inputs.length)
      const active = previous.filter(
        (job) => activeTask(job.state) && job.request.kind === 'branch',
      )

      if (active.length + inputs.length > 4) {
        throw new Error('At most four independent branch orchestrators can run at once')
      }

      const scopes = previous
        .filter((job) => ownsTaskPaths(job.state) && job.request.kind === 'branch')
        .map((job) => job.request.writePaths)

      for (const input of inputs) {
        if (scopes.some((scope) => scopesOverlap(scope, input.writePaths))) {
          throw new Error('Independent branch tasks require disjoint write scopes')
        }

        scopes.push(input.writePaths)
      }

      const jobs: Delegation[] = []

      for (const input of inputs) {
        const request: DelegationRequest = {
          ...input,
          ...origin,
          kind: 'branch',
          id: randomUUID(),
          root: this.store.projectRoot,
          createdAt: new Date().toISOString(),
        }
        const state: DelegationStatus = {
          id: request.id,
          status: 'queued',
          updatedAt: request.createdAt,
          mergeRequested: input.branch.mergeToMain === true,
        }
        const directory = delegationDirectory(this.store, request.id)
        await atomicJson(join(directory, 'request.json'), request)
        await atomicJson(join(directory, 'controls.json'), {
          ...emptyControls,
          mergeRequested: input.branch.mergeToMain === true,
          mergeRequestId: input.branch.mergeToMain ? randomUUID() : undefined,
        })
        await atomicJson(join(directory, 'status.json'), state)
        jobs.push({ request, state })
      }

      await atomicJson(join(this.store.directory, 'delegations', 'index.json'), [
        ...retained.map((job) => job.request.id),
        ...jobs.map((job) => job.request.id),
      ])

      // Persist the whole batch before launching any worker. Failed starts remain inspectable.
      for (const job of jobs) {
        try {
          await launch(job.request)
        } catch (error) {
          job.state = { ...job.state, status: 'failed', error: String(error) }
          await atomicJson(
            join(delegationDirectory(this.store, job.request.id), 'status.json'),
            job.state,
          )
        }
      }

      return jobs
    })
  }

  async requestMerge(
    ids: string[],
    origin: DelegationOrigin,
    launch: (request: DelegationRequest) => Promise<void>,
  ): Promise<Delegation[]> {
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length) {
      throw new Error('Choose one to four distinct branch tasks to merge')
    }

    return this.locked(async () => {
      const jobs = await Promise.all(ids.map((id) => this.get(id)))
      const running = (await this.list()).filter(
        (job) => job.request.kind === 'branch' && activeTask(job.state),
      ).length
      const restarting = jobs.filter((job) => job.state.status === 'published').length

      if (running + restarting > 4) {
        throw new Error('At most four branch orchestrators can run; finish or cancel active tasks')
      }

      for (const job of jobs) {
        if (job.request.kind === 'branch' && job.state.status === 'needs_attention') {
          const detail = job.state.error || job.state.summary || 'Inspect the task handoff.'
          throw new Error(
            `Branch ${job.request.id} needs_attention: ${detail.slice(0, 500)}. ` +
              'Read review_receipts, recover any failed required checks on the intended head, ' +
              'then resume the task. These gates also apply to host-managed PR merges.',
          )
        }

        if (
          job.request.kind !== 'branch' ||
          (!activeTask(job.state) && !['published', 'complete'].includes(job.state.status))
        ) {
          throw new Error('Merge requests require active or published independent branch tasks')
        }
      }

      for (const job of jobs) {
        if (job.state.status === 'complete') {
          continue
        }

        const directory = delegationDirectory(this.store, job.request.id)
        const path = join(directory, 'controls.json')
        const control = await readJson<TaskControls>(path)

        if (!control || control.cancelled) {
          throw new Error('Cannot merge a cancelled task')
        }

        await atomicJson(path, {
          ...control,
          mergeRequested: true,
          mergeRequestId: control.mergeRequestId ?? randomUUID(),
        })
        job.request = { ...job.request, ...origin }
        await atomicJson(join(directory, 'request.json'), job.request)

        if (activeTask(job.state)) {
          continue
        }

        job.state = {
          ...job.state,
          status: 'queued',
          updatedAt: new Date().toISOString(),
          deliveryVersion: (job.state.deliveryVersion ?? 0) + 1,
          mergeRequested: true,
          pid: undefined,
          error: undefined,
        }
        await atomicJson(join(directory, 'status.json'), job.state)

        try {
          await launch(job.request)
        } catch (error) {
          job.state = { ...job.state, status: 'needs_attention', error: String(error) }
          await atomicJson(join(directory, 'status.json'), job.state)
        }
      }

      return jobs
    })
  }

  async resume(
    id: string,
    origin: DelegationOrigin,
    launch: (request: DelegationRequest) => Promise<void>,
  ): Promise<Delegation> {
    return this.locked(async () => {
      const job = await this.get(id)

      if (!['paused', 'needs_attention', 'failed'].includes(job.state.status)) {
        throw new Error(
          'Resume requires a paused or failed task; cancelled work needs a new request',
        )
      }

      const others = (await this.list()).filter(
        (other) =>
          other.request.id !== id &&
          (other.request.kind === 'branch') === (job.request.kind === 'branch'),
      )
      const limit = job.request.kind === 'branch' ? 4 : 2

      checkWriteReservations(job.request, others)

      if (others.filter((other) => activeTask(other.state)).length >= limit) {
        throw new Error(
          `Wait for an active task to finish before resuming; the concurrency limit is ${limit}`,
        )
      }

      const directory = delegationDirectory(this.store, id)

      if (
        job.state.candidate &&
        !['branch', 'implementation'].includes(job.request.kind) &&
        !(await readJson(join(directory, 'workspace.json')))
      ) {
        throw new Error('Use revise_tasks to recover this legacy candidate before resuming')
      }

      const controls = await readJson<TaskControls>(join(directory, 'controls.json'))

      if (!controls) {
        throw new Error('Task controls are unavailable')
      }

      const previousHostHandoff = handoffForResume(job, controls)
      job.request = { ...job.request, ...origin }
      job.state = {
        ...job.state,
        status: 'queued',
        pid: undefined,
        error: undefined,
        hostActions: undefined,
        summary: 'Resuming retained task',
        receipts: undefined,
        workflowTaskId: undefined,
        receiptAttempt: undefined,
        children: undefined,
        updatedAt: new Date().toISOString(),
        deliveryVersion: (job.state.deliveryVersion ?? 0) + 1,
        progressFile: `coordinator-${randomUUID()}.json`,
      }
      await atomicJson(join(directory, 'controls.json'), {
        ...controls,
        previousHostHandoff,
        cancelled: false,
        paused: false,
      })
      await atomicJson(join(directory, 'request.json'), job.request)
      await atomicJson(join(directory, 'status.json'), job.state)

      try {
        await launch(job.request)
      } catch (error) {
        job.state = { ...job.state, status: 'needs_attention', error: String(error) }
        await atomicJson(join(directory, 'status.json'), job.state)
      }

      return this.get(id)
    })
  }

  async control(
    id: string,
    action: 'message' | 'cancel' | 'pause',
    text?: string,
  ): Promise<TaskControls> {
    return this.locked(async () => {
      const job = await this.get(id)

      if (!ownsTaskPaths(job.state)) {
        throw new Error('Task already stopped; inspect its result or delegate a follow-up task')
      }

      const path = join(delegationDirectory(this.store, id), 'controls.json')
      const controls = (await readJson<TaskControls>(path)) ?? structuredClone(emptyControls)

      if (action === 'message') {
        if (
          !text?.trim() ||
          text.length > 12000 ||
          controls.messages.length >= 32 ||
          JSON.stringify(controls).length + text.length > 48000
        ) {
          throw new Error('Task messages require nonempty text within the 32-message/48 KB budget')
        }

        if (job.request.kind === 'implementation') {
          throw new Error(
            'This implementation task has a fixed design. Send observations with task_control ' +
              'action=evidence. For a scope change use ' +
              'workflow with the revised design after the current reservation is released.',
          )
        }

        controls.revision++
        controls.messages.push({ revision: controls.revision, text })
      } else if (action === 'pause') {
        controls.paused = true
      } else {
        controls.cancelled = true
        controls.paused = false

        if (job.state.status === 'paused') {
          await atomicJson(join(delegationDirectory(this.store, id), 'status.json'), {
            ...job.state,
            status: 'cancelled',
            updatedAt: new Date().toISOString(),
          })
        }
      }

      await atomicJson(path, controls)
      return controls
    })
  }
}
