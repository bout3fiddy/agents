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
export type DelegationRequest = DelegateInput & {
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
}
export type Delegation = { request: DelegationRequest; state: DelegationStatus }
export type TaskControls = {
  revision: number
  messages: { revision: number; text: string }[]
  cancelled: boolean
}
export const emptyControls: TaskControls = { revision: 0, messages: [], cancelled: false }
const activeStates = new Set(['queued', 'running', 'checking', 'applying'])

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

    if (state.status === 'queued' && Date.now() - Date.parse(request.createdAt) > 60000) {
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
    origin: { session: string; originEntry?: string; model: string },
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
      const active = previous.filter((job) => activeTask(job.state))

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
