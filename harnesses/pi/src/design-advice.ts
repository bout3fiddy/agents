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
): Promise<string> {
  if (!Check(consultationSchema, raw)) {
    throw new Error('Invalid design consultation')
  }

  const documents: { path: string; content: string }[] = []

  for (const path of raw.paths ?? []) {
    const content = (await readBoundedFile(await safePath(store.projectRoot, path))).toString(
      'utf8',
    )
    documents.push({ path, content })
  }

  const input = JSON.stringify({
    question: raw.question,
    confirmedContext: raw.context,
    userMessages: raw.historyMessages === 0 ? [] : userMessages.slice(-(raw.historyMessages ?? 12)),
    olderUserMessagesOmitted: Math.max(0, userMessages.length - (raw.historyMessages ?? 12)),
    documents,
    folderInstructions: await instructions(store.projectRoot, raw.paths ?? []),
    task: 'Give independent design advice. Open questions are expected. Do not implement.',
  })

  if (Buffer.byteLength(input) > 160000) {
    throw new Error(
      'Consultation exceeds 160 KB; select fewer paths or reduce historyMessages ' +
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
  private closed = false
  epoch = 0

  constructor(
    private readonly run: AdviceRunner = runDesignAdvice,
    private readonly changed: (count: number) => void = () => {},
  ) {}

  async start(
    store: StateStore,
    session: string,
    input: string,
    question: string,
    notify: (job: Consultation) => void,
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
    }
    const controller = new AbortController()
    const path = join(store.directory, 'consultations', `${job.id}.json`)
    const pending: Pending = { job, controller, done: Promise.resolve(), claimed: false }
    this.pending.set(job.id, pending)
    this.changed(this.pending.size)

    // Reserve the slot before any await; persistence and dispatch share the same completion path.
    pending.done = (async () => {
      try {
        await atomicJson(`${path}.input.json`, JSON.parse(input))
        await atomicJson(path, job)
        controller.signal.throwIfAborted()
        job.advice = await this.run(input, controller.signal, `${path}.claude.jsonl`)
        controller.signal.throwIfAborted()
        job.status = 'complete'
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = error instanceof Error ? error.message.slice(0, 2000) : String(error)
      }

      job.finishedAt = new Date().toISOString()

      try {
        await atomicJson(path, job)
      } catch {
        job.status = 'failed'
        job.error = 'Could not persist the consultation result'
      }

      this.pending.delete(job.id)
      this.changed(this.pending.size)

      if (!controller.signal.aborted && !pending.claimed) {
        notify({ ...job })
      }
    })()

    // Delivery can fail during teardown; the persisted result remains inspectable.
    pending.done.catch(() => {})
    return { ...job }
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
  }
}
