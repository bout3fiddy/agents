import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { claudeArguments, parseClaudeTrace } from './claude-worker.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { atomicJson, readJson, type StateStore } from './state.ts'
import { readBoundedFile, safePath } from './paths.ts'
import { instructions } from './project.ts'

export const consultationSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 16000 }),
  context: Type.Optional(Type.String({ maxLength: 16000 })),
  paths: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 })),
  excerpts: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ maxLength: 300 }),
        startLine: Type.Integer({ minimum: 1 }),
        lines: Type.Integer({ minimum: 1, maximum: 160 }),
      }),
      { maxItems: 6 },
    ),
  ),
  depth: Type.Optional(Type.Union([Type.Literal('brief'), Type.Literal('deep')])),
  historyMessages: Type.Optional(Type.Integer({ minimum: 0, maximum: 12 })),
})

export type ConsultationInput = Static<typeof consultationSchema>
export type Advice = { text: string; model: string; toolsUsed?: string[] }
export type Consultation = {
  id: string
  session: string
  question: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt?: string
  advice?: Advice
  error?: string
  requestId?: string
  delivery?: { via: 'tool' | 'automatic' | 'superseded' | 'cancelled'; at: string }
}
export type AdviceRunner = (
  input: string,
  signal: AbortSignal,
  tracePath?: string,
) => Promise<Advice>

export async function consultationInput(
  store: StateStore,
  raw: ConsultationInput,
  userMessages: string[],
  requestId?: string,
): Promise<string> {
  if (!Check(consultationSchema, raw)) {
    throw new Error('Invalid design consultation')
  }

  const documents: { path: string; content: string }[] = []

  for (const path of raw.paths ?? []) {
    const content = (await readBoundedFile(await safePath(store.projectRoot, path))).toString(
      'utf8',
    )

    if (content.length > 16000) {
      throw new Error(`${path} exceeds 16 KB; select relevant line ranges with excerpts`)
    }

    documents.push({ path, content })
  }

  for (const excerpt of raw.excerpts ?? []) {
    const file = await readBoundedFile(await safePath(store.projectRoot, excerpt.path))
    const content = file
      .toString('utf8')
      .split('\n')
      .slice(excerpt.startLine - 1, excerpt.startLine - 1 + excerpt.lines)
      .join('\n')
    documents.push({ path: `${excerpt.path}:${excerpt.startLine}`, content })
  }

  const input = JSON.stringify({
    question: raw.question,
    requestId,
    responseBudgetWords: raw.depth === 'deep' ? 700 : 350,
    confirmedContext: raw.context,
    userMessages: raw.historyMessages === 0 ? [] : userMessages.slice(-(raw.historyMessages ?? 12)),
    olderUserMessagesOmitted: Math.max(0, userMessages.length - (raw.historyMessages ?? 12)),
    documents,
    folderInstructions: await instructions(store.projectRoot, [
      ...(raw.paths ?? []),
      ...(raw.excerpts ?? []).map((item) => item.path),
    ]),
    task: 'Give independent design advice. Open questions are expected. Do not implement.',
  })

  if (Buffer.byteLength(input) > 48000) {
    throw new Error(
      'Consultation exceeds 48 KB; select smaller excerpts or reduce historyMessages ' +
        '(0 omits history). Supply necessary constraints in context.',
    )
  }

  return input
}

export async function runDesignAdvice(
  input: string,
  signal: AbortSignal,
  tracePath?: string,
): Promise<Advice> {
  signal.throwIfAborted()
  const role = await loadRole('design-advisor')
  const scratch = await mkdtemp(join(tmpdir(), 'pi-design-advice-'))

  try {
    const config = join(scratch, 'mcp.json')
    const prompt = join(scratch, 'system.txt')
    await atomicJson(config, { mcpServers: {} })
    await writeFile(prompt, await rolePrompt('design-advisor'), { mode: 0o600 })

    if (tracePath) {
      await writeFile(tracePath, '', { mode: 0o600 })
    }

    signal.throwIfAborted()
    const invocation = promisify(execFile)(
      process.env.PI_HARNESS_CLAUDE_BIN ?? 'claude',
      claudeArguments(role, config, prompt, true),
      {
        cwd: scratch,
        signal,
        timeout: role.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8_000_000,
      },
    )
    let traceError: unknown
    invocation.child.stdout?.on('data', (chunk: Buffer | string) => {
      if (tracePath && !traceError) {
        try {
          appendFileSync(tracePath, chunk)
        } catch (error) {
          traceError = error
          invocation.child.kill('SIGKILL')
        }
      }
    })
    invocation.child.stdin?.on('error', () => {})
    invocation.child.stdin?.end(input)
    const { stdout } = await invocation
    signal.throwIfAborted()

    if (traceError) {
      throw traceError
    }

    const { response, toolsUsed } = parseClaudeTrace(stdout)

    if (
      !response ||
      response.is_error ||
      !response.result?.trim() ||
      response.result.length > 32000
    ) {
      throw new Error('Fable returned an error, empty advice or advice exceeding 32 KB')
    }

    return {
      text: response.result,
      model: `claude-cli/${Object.keys(response.modelUsage ?? {})[0] ?? role.model}`,
      toolsUsed,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

type Pending = {
  job: Consultation
  controller: AbortController
  done: Promise<void>
  claimed: boolean
}

export class DesignConsultations {
  private readonly pending = new Map<string, Pending>()
  private readonly ready = new Map<string, Consultation>()
  private readonly stores = new Map<string, StateStore>()
  private readonly claiming = new Set<string>()
  private closed = false
  epoch = 0

  constructor(
    private readonly run: AdviceRunner = runDesignAdvice,
    private readonly changed: (count: number) => void = () => {},
    private readonly persist: typeof atomicJson = atomicJson,
  ) {}

  async start(
    store: StateStore,
    session: string,
    input: string,
    question: string,
    notify: (job: Consultation) => void | Promise<void>,
    signal?: AbortSignal,
    epoch = this.epoch,
  ): Promise<Consultation> {
    signal?.throwIfAborted()

    if (this.closed || epoch !== this.epoch) {
      throw new Error('Design consultation context changed; start again in the current session')
    }

    if (this.pending.size >= 2) {
      throw new Error('Two design consultations are already running; finish or cancel one')
    }

    const job: Consultation = {
      id: randomUUID(),
      session,
      question,
      status: 'running',
      startedAt: new Date().toISOString(),
      requestId: (JSON.parse(input) as { requestId?: string }).requestId,
    }
    const controller = new AbortController()
    const path = join(store.directory, 'consultations', `${job.id}.json`)
    const pending: Pending = { job, controller, done: Promise.resolve(), claimed: false }
    this.pending.set(job.id, pending)
    this.stores.set(job.id, store)
    this.changed(this.pending.size)

    // Reserve the slot before any await; persistence and dispatch share the same completion path.
    pending.done = (async () => {
      try {
        await this.persist(`${path}.input.json`, JSON.parse(input))
        await this.persist(path, job)
        controller.signal.throwIfAborted()
        job.advice = await this.run(input, controller.signal, `${path}.claude.jsonl`)
        controller.signal.throwIfAborted()
        job.status = 'complete'
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = error instanceof Error ? error.message.slice(0, 2000) : String(error)
      }

      job.finishedAt = new Date().toISOString()

      let persisted = true

      try {
        await this.persist(path, job)
      } catch {
        persisted = false
        job.status = 'failed'
        job.error = 'Could not persist the consultation result'
      }

      this.pending.delete(job.id)
      this.changed(this.pending.size)

      if (!controller.signal.aborted) {
        if (persisted) {
          this.ready.set(job.id, { ...job })
        } else {
          this.stores.delete(job.id)
        }

        if (!pending.claimed) {
          await notify({ ...job })
        }
      }
    })()

    // Delivery can fail during teardown; the persisted result remains inspectable.
    pending.done.catch(() => {})
    return { ...job }
  }

  available(session: string): Consultation[] {
    return [...this.ready.values()].filter((job) => job.session === session)
  }

  suppress(id: string): void {
    this.ready.delete(id)
    this.stores.delete(id)
  }

  async discard(store: StateStore, session: string, id: string): Promise<void> {
    const job = await this.get(store, session, id)
    job.delivery = { via: 'superseded', at: new Date().toISOString() }
    await this.persist(join(store.directory, 'consultations', `${id}.json`), job)
    this.suppress(id)
  }

  async claim(
    store: StateStore,
    session: string,
    id: string,
    via: NonNullable<Consultation['delivery']>['via'],
    options: { valid?: () => boolean; signal?: AbortSignal } = {},
  ): Promise<Consultation | undefined> {
    if (this.claiming.has(id)) {
      return undefined
    }

    this.claiming.add(id)
    const epoch = this.epoch
    const valid = () =>
      !options.signal?.aborted &&
      (options.valid?.() ?? true) &&
      (via === 'superseded' || via === 'cancelled' || (!this.closed && epoch === this.epoch))

    try {
      const job = await this.get(store, session, id)

      if (job.delivery) {
        this.ready.delete(id)
        return undefined
      }

      if (job.status === 'running' || !valid()) {
        return undefined
      }

      job.delivery = { via, at: new Date().toISOString() }
      const path = join(store.directory, 'consultations', `${id}.json`)
      await this.persist(path, job)

      if (!valid()) {
        job.delivery =
          epoch !== this.epoch || this.closed
            ? { via: 'superseded', at: new Date().toISOString() }
            : undefined
        await this.persist(path, job)

        if (job.delivery) {
          this.suppress(id)
        }

        return undefined
      }

      this.suppress(id)
      return job
    } finally {
      this.claiming.delete(id)
    }
  }

  async get(store: StateStore, session: string, id: string): Promise<Consultation> {
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      throw new Error('Invalid consultation ID')
    }

    const job =
      this.pending.get(id)?.job ??
      (await readJson<Consultation>(join(store.directory, 'consultations', `${id}.json`)))

    if (!job || job.session !== session) {
      throw new Error('No consultation with this ID in the current session')
    }

    if (job.status === 'running' && !this.pending.has(id)) {
      return { ...job, status: 'cancelled', error: 'Consultation owner stopped; run it again' }
    }

    return { ...job }
  }

  async settle(id: string, cancel: boolean, signal?: AbortSignal): Promise<void> {
    const pending = this.pending.get(id)

    if (!pending) {
      return
    }

    if (cancel) {
      pending.controller.abort()
      await pending.done
      return
    }

    signal?.throwIfAborted()
    pending.claimed = true
    let interrupt!: () => void
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error('Consultation wait interrupted; advice is still running'))
      signal?.addEventListener('abort', interrupt, { once: true })
    })

    try {
      await Promise.race([pending.done, interrupted])
    } finally {
      signal?.removeEventListener('abort', interrupt)
      pending.claimed = false
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.cancelAll()
  }

  async cancelAll(): Promise<void> {
    this.epoch++
    const pending = [...this.pending.values()]

    for (const item of pending) {
      item.controller.abort()
    }

    await Promise.allSettled(pending.map((item) => item.done))

    for (const job of this.ready.values()) {
      const store = this.stores.get(job.id)

      if (store) {
        await this.claim(store, job.session, job.id, 'superseded').catch(() => {})
      }
    }

    this.ready.clear()
    this.stores.clear()
  }
}
