import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { StateStore, atomicJson, readJson } from './state.ts'
import { acquireLock } from './lock.ts'
import { matches, validateScope } from './paths.ts'
import type { Receipt } from './contracts.ts'
import { validateDesign } from './contracts.ts'
import type { BranchPlan, BranchTaskInput } from './branch-contracts.ts'

export const delegateSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 8000 }),
    context: Type.String({ maxLength: 24000 }),
    kind: Type.Union([
      Type.Literal('documents'),
      Type.Literal('research'),
      Type.Literal('maintenance'),
      Type.Literal('implementation'),
    ]),
    writePaths: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 }),
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
  updatedAt: string
  pid?: number
  candidate?: string
  summary?: string
  error?: string
  changedPaths?: string[]
  receipts?: Receipt[]
  children?: { role: string; model: string; verdict: string }[]
  branch?: string
  base?: string
  commit?: string
  pullRequest?: string
  mergeBase?: string
  mergeAttempts?: number
  deliveryVersion?: number
  mergeRequested?: boolean
}
export type Delegation = { request: DelegationRequest; state: DelegationStatus }
export type TaskControls = {
  revision: number
  messages: { revision: number; text: string }[]
  cancelled: boolean
  mergeRequested?: boolean
  mergeRequestId?: string
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

export function delegationView(job: Delegation) {
  const { receipts, ...state } = job.state
  return {
    kind: job.request.kind,
    task: job.request.task.slice(0, 500),
    writePaths: job.request.writePaths,
    ...state,
    checks: receipts?.map((receipt) => ({
      check: receipt.check,
      status: receipt.status,
      snapshot: receipt.snapshot,
    })),
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

    return { request, state }
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
  ): Promise<Delegation> {
    if (!Check(delegateSchema, input)) {
      throw new Error('Invalid delegated task; provide task, context, kind and writePaths')
    }

    validateScope(input.writePaths)

    if (input.kind === 'research' && input.writePaths.length) {
      throw new Error('Research tasks have no write scope')
    }

    if (
      input.kind === 'documents' &&
      (!input.writePaths.length || input.writePaths.includes('**'))
    ) {
      throw new Error('Document tasks need specific files or document directories')
    }

    return this.locked(async () => {
      const checkpoint = input.kind === 'implementation' ? await this.store.checkpoint() : undefined

      if (input.kind === 'implementation' && (!checkpoint || checkpoint.unresolved.length)) {
        throw new Error('Substantial implementation requires a settled accepted design')
      }

      const request: DelegationRequest = {
        ...input,
        ...origin,
        writePaths: checkpoint?.writePaths ?? input.writePaths,
        id: randomUUID(),
        root: this.store.projectRoot,
        createdAt: new Date().toISOString(),
        checkpointHash: checkpoint?.hash,
      }
      const previous = await this.list()
      const active = previous.filter(
        (job) => activeTask(job.state) && job.request.kind !== 'branch',
      )

      if (active.length >= 2) {
        throw new Error(
          'Two background tasks are active; finish or cancel one before starting more',
        )
      }

      for (const job of active) {
        const exclusive = [request.kind, job.request.kind].includes('implementation')

        if (
          (exclusive && request.writePaths.length && job.request.writePaths.length) ||
          scopesOverlap(request.writePaths, job.request.writePaths)
        ) {
          throw new Error(
            `Files already owned by task ${job.request.id}; send it a message instead`,
          )
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
      const retained = previous
        .filter((job) => activeTask(job.state))
        .concat(previous.filter((job) => !activeTask(job.state)).slice(-197))
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
      validateScope(input.writePaths)

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
      const active = previous.filter(
        (job) => activeTask(job.state) && job.request.kind === 'branch',
      )

      if (active.length + inputs.length > 4) {
        throw new Error('At most four independent branch orchestrators can run at once')
      }

      const scopes = active.map((job) => job.request.writePaths)

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

      const retained = previous
        .filter((job) => activeTask(job.state))
        .concat(previous.filter((job) => !activeTask(job.state)).slice(-190))
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

  async control(id: string, action: 'message' | 'cancel', text?: string): Promise<TaskControls> {
    return this.locked(async () => {
      const job = await this.get(id)

      if (!activeTask(job.state)) {
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
          throw new Error('Cancel and accept updated scope before changing an implementation task')
        }

        controls.revision++
        controls.messages.push({ revision: controls.revision, text })
      } else {
        controls.cancelled = true
      }

      await atomicJson(path, controls)
      return controls
    })
  }
}
