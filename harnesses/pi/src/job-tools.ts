import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Type, type Static } from 'typebox'
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent'
import {
  designSchema,
  implementerModelSchema,
  taskIsolationSchema,
  taskTitleSchema,
  thinkingSchema,
  writePathSchema,
} from './contracts.ts'
import { receiptView } from './context.ts'
import type { Receipt } from './contracts.ts'
import { liveSession } from './delivery.ts'
import { requireDependencies } from './dependencies.ts'
import { structuredResult } from './file-tools.ts'
import { freshBootstrapRoot, hostFileAllowed, workerHandoff } from './host-file-routing.ts'
import { validBranch } from './job-git.ts'
import { launchJob, type Launcher } from './job-runner.ts'
import {
  jobDirectory,
  jobLabel,
  JobStore,
  jobView,
  primaryRoot,
  type Job,
  type JobEvent,
  type JobSpec,
} from './job-store.ts'
import { validateWriteScope } from './paths.ts'
import { readJson, StateStore } from './state.ts'
import { sweepTemporary } from './temp.ts'
import type { LiveWorkerInfo, LiveWorkerState } from './worker-live.ts'
import { WorkerMailbox } from './worker-mailbox.ts'

export const outcomeType = 'pi-job-outcome'
const openType = 'pi-open-jobs'
const nudgeType = 'pi-job-nudge'

/** Tools a script may call. Everything that reads or drives jobs is scriptable. */
export const jobTools = ['job_start', 'job_status', 'job_message', 'job_retry', 'job_close']

const stores = new Map<string, JobStore>()

/** One connection per repository for the life of the host process. */
export function jobStore(cwd: string): JobStore {
  const root = primaryRoot(cwd)
  let store = stores.get(root)

  if (!store) {
    store = new JobStore(root)
    stores.set(root, store)
  }

  return store
}

// Declared so a script receives each result as an object, not as text.
const jobOutput = Type.Object({}, { additionalProperties: true })

const startParameters = Type.Object(
  {
    title: taskTitleSchema,
    task: Type.String({
      minLength: 1,
      maxLength: 16000,
      description: 'The complete assignment. The worker sees this and nothing of the conversation.',
    }),
    mode: Type.Union(
      [Type.Literal('implement'), Type.Literal('documents'), Type.Literal('research')],
      {
        description:
          'implement: code changes, verified by the project checks. documents: Markdown or text ' +
          'only, checked for formatting. research: read-only, returns a report.',
      },
    ),
    design: Type.Optional(designSchema),
    writePaths: Type.Optional(Type.Array(writePathSchema, { maxItems: 50 })),
    deliver: Type.Optional(
      Type.Union([Type.Literal('apply'), Type.Literal('branch')], {
        description:
          'apply (default): write the verified result into the checkout. branch: commit it on ' +
          'a local branch and leave the checkout alone; push or open a PR yourself when the ' +
          'user asked for that.',
      }),
    ),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
    base: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 150,
        description: 'Commit or ref to start from. Default: the working tree, or the branch tip.',
      }),
    ),
    thinking: Type.Optional(thinkingSchema),
    implementerModel: Type.Optional(implementerModelSchema),
    isolation: taskIsolationSchema,
    key: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        description:
          'Idempotency key. Starting the same key again in this session returns the first job.',
      }),
    ),
    checkout: Type.Optional(
      Type.String({
        description: 'Absolute root of another checkout or worktree of this repository.',
      }),
    ),
  },
  { additionalProperties: false },
)

type StartInput = Static<typeof startParameters>

function specFor(input: StartInput, model: string): JobSpec {
  const research = input.mode === 'research'
  const writePaths = research ? [] : (input.writePaths ?? input.design?.writePaths ?? [])

  if (!research && !writePaths.length) {
    throw new Error('Name the writePaths this job may change')
  }

  validateWriteScope(writePaths)
  const deliver = research ? 'none' : (input.deliver ?? 'apply')

  if (deliver === 'branch' && !(input.branch && validBranch(input.branch))) {
    throw new Error('Branch delivery needs a valid branch name')
  }

  // A ref reaches Git as an argument: it must look like a ref and never like an option.
  if (input.base && !/^[A-Za-z0-9][A-Za-z0-9_./~^-]{0,150}$/.test(input.base)) {
    throw new Error('base must be a commit, branch or tag name')
  }

  if (input.design && input.mode !== 'implement') {
    throw new Error('A design belongs to an implement job')
  }

  return {
    title: input.title,
    task: input.task,
    mode: input.mode,
    deliver,
    writePaths,
    model,
    ...(input.design && { design: { ...input.design, writePaths } }),
    ...(input.base && { base: input.base }),
    ...(deliver === 'branch' && { branch: input.branch }),
    ...(input.thinking && { thinking: input.thinking }),
    ...(input.implementerModel && { implementerModel: input.implementerModel }),
    ...(input.isolation && { isolation: input.isolation }),
  }
}

async function checkoutRoot(ctx: ExtensionContext, store: JobStore, checkout?: string) {
  if (checkout === undefined) {
    return realpath(ctx.cwd)
  }

  const root = await realpath(checkout).catch(() => {
    throw new Error(`No checkout at ${checkout}`)
  })

  if (primaryRoot(root) !== store.root) {
    throw new Error(`${root} belongs to another repository; start its jobs from a session there`)
  }

  return root
}

/** The running worker of a job, if one is accepting guidance right now. */
async function activeWorker(job: Job): Promise<string | undefined> {
  const directory = join(new StateStore(job.root).directory, 'workers')
  const names = await readdir(directory).catch(() => [] as string[])

  for (const name of names.sort().reverse()) {
    const path = join(directory, name)
    const info = await readJson<LiveWorkerInfo>(join(path, 'info.json')).catch(() => undefined)

    if (info?.taskId !== job.id) {
      continue
    }

    const state = await readJson<LiveWorkerState>(join(path, 'state.json')).catch(() => undefined)

    if (state?.status === 'running') {
      return path
    }
  }

  return undefined
}

function outcomeMessage(jobs: Job[], events: JobEvent[]) {
  return {
    type: 'custom_message' as const,
    customType: outcomeType,
    display: false,
    content:
      'Background job outcome. A done job passed the checks the host ran on exactly this ' +
      'result, and an apply delivery is already in the checkout: do not rerun its checks. ' +
      'Tell the user what they can now use or must decide, briefly. For needs_attention read ' +
      'the error: do host-only actions yourself, then job_retry with guidance, or job_close ' +
      'with the reason if you resolved it another way. A cancelled job was stopped by the ' +
      'user: never restart it without a new request.\n' +
      JSON.stringify(jobs.map(jobView)),
    details: { events: events.map((event) => event.id) },
  }
}

/**
 * Delivery is level-triggered. Nothing depends on a wake arriving: at every boundary and idle
 * tick the feed reads what this session has not been shown and offers it again. An outcome is
 * acknowledged only once its message is found persisted in the session.
 */
class JobFeed {
  current: ExtensionContext | undefined
  private closed = false
  private timer: ReturnType<typeof setInterval> | undefined
  private offered = { key: '', at: 0 }

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly retryMs: number,
  ) {}

  open(ctx: ExtensionContext) {
    this.closed = false
    this.current = ctx
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
  }

  observe(tickMs: number) {
    this.timer = setInterval(() => {
      if (this.current && !this.closed) {
        this.idle(this.current)
      }
    }, tickMs)
    this.timer.unref()
  }

  /** Outcomes of this session not yet in its transcript, and the status line of its jobs. */
  private pending(ctx: ExtensionContext) {
    const session = this.closed ? undefined : liveSession(ctx)

    if (session === undefined) {
      return undefined
    }

    const store = jobStore(ctx.cwd)
    store.reconcile()
    const persisted = new Set(
      ctx.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'custom_message' && entry.customType === outcomeType
            ? ((entry.details as { events?: number[] } | undefined)?.events ?? [])
            : [],
        ),
    )
    const events = store.pendingEvents(session)
    store.acknowledge(events.filter((event) => persisted.has(event.id)).map((event) => event.id))
    const fresh = events.filter((event) => !persisted.has(event.id))
    const active = store
      .list({ session, open: true })
      .filter((job) => job.status !== 'needs_attention')
      .map((job) => `${jobLabel(job)} ${job.phase}`)
    ctx.ui.setStatus('pi-jobs', active.length ? 'Jobs · ' + active.join(' · ') : undefined)
    return fresh.length
      ? {
          events: fresh,
          jobs: [...new Set(fresh.map((event) => event.job))].map((id) => store.get(id)),
        }
      : undefined
  }

  /** While the host is idle, an undelivered outcome starts a turn. Repeats are spaced out. */
  idle(ctx: ExtensionContext) {
    try {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return
      }

      const pending = this.pending(ctx)
      const key = pending?.events.map((event) => event.id).join(',') ?? ''

      if (!pending || (key === this.offered.key && Date.now() - this.offered.at < this.retryMs)) {
        return
      }

      this.offered = { key, at: Date.now() }
      this.pi.sendMessage(outcomeMessage(pending.jobs, pending.events), {
        triggerTurn: true,
        deliverAs: 'followUp',
      })
    } catch (error) {
      if (liveSession(ctx) === undefined) {
        this.close()
      } else {
        ctx.ui.setStatus('pi-jobs', `Job feed error: ${String(error).slice(0, 120)}`)
      }
    }
  }

  /** At a completed boundary the outcome joins the running turn instead of starting another. */
  boundary(
    event: Pick<AgentBeforeSettleEvent, 'outcome' | 'entries' | 'context'>,
    ctx: ExtensionContext,
  ) {
    if (event.outcome !== 'completed') {
      return undefined
    }

    const pending = this.pending(ctx)

    if (!pending) {
      return undefined
    }

    this.offered = { key: pending.events.map((item) => item.id).join(','), at: Date.now() }
    return {
      entries: [...event.entries, outcomeMessage(pending.jobs, pending.events)],
      ...(event.context.pendingMessages.length ? {} : { continue: true }),
    }
  }
}

/** A run that answered an outcome with nothing is asked once to act on it or say why not. */
function emptyAnswer(event: AgentBeforeSettleEvent) {
  const messages = event.context.contextMessages
  const last = messages.at(-1)
  const previous = messages.at(-2)

  if (
    event.outcome !== 'completed' ||
    event.continue ||
    event.context.pendingMessages.length ||
    last?.role !== 'assistant' ||
    last.stopReason !== 'stop' ||
    last.content.some((part) => part.type === 'text' && part.text.trim()) ||
    previous?.role !== 'custom' ||
    previous.customType !== outcomeType
  ) {
    return undefined
  }

  return {
    entries: [
      ...event.entries,
      {
        type: 'custom_message' as const,
        customType: nudgeType,
        display: false,
        content:
          'The job outcome above received an empty reply. Take its next step now, or tell the ' +
          'user what decision or dependency is holding it.',
      },
    ],
    continue: true,
  }
}

/** Every turn starts from the recorded state of the session's open jobs, not from memory. */
function openJobs(ctx: ExtensionContext) {
  const session = liveSession(ctx)
  const jobs = session ? jobStore(ctx.cwd).list({ session, open: true }) : []

  if (!jobs.length) {
    return undefined
  }

  return {
    message: {
      customType: openType,
      display: false,
      content:
        'Open jobs of this session, as recorded. Running ones report on their own: do not ' +
        'poll, wait or predict their results. A needs_attention job is yours to resolve.\n' +
        JSON.stringify(jobs.map(jobView)),
    },
  }
}

async function destination(cwd: string, path: string): Promise<string> {
  let current = resolve(cwd, path)
  const missing: string[] = []

  for (let depth = 0; depth < 100; depth++) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) {
        throw error
      }

      missing.unshift(basename(current))
      current = dirname(current)
    }
  }

  throw new Error('Write destination exceeds the directory depth limit')
}

/** Host file tools write setup, scratch and small decisions. Product changes are jobs. */
async function hostWriteBlock(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  bootstrapRoot: string | undefined,
) {
  const input = event.input as { path?: string; paths?: string[]; format?: boolean }
  const paths =
    event.toolName === 'write' || event.toolName === 'edit'
      ? [input.path ?? '']
      : event.toolName === 'document_check' && input.format
        ? (input.paths ?? [])
        : []

  if (!paths.length) {
    return undefined
  }

  // SDK file tools expand shorthand. Require ordinary paths so both sides address the same file.
  if (
    paths.some(
      (path) => !path || /^[@~]|^file:|[^\S ]/u.test(path) || path.split('/').includes('..'),
    )
  ) {
    return { block: true, reason: 'Use a plain path without shorthand. ' + workerHandoff }
  }

  const cwd = await realpath(ctx.cwd)

  for (const path of paths) {
    const target = await destination(cwd, path)
    const inside = !relative(cwd, target).startsWith('..')

    if (!inside || !(await hostFileAllowed(cwd, cwd, target, event, bootstrapRoot))) {
      return { block: true, reason: workerHandoff }
    }
  }

  return undefined
}

function registerTools(pi: ExtensionAPI, launch: Launcher) {
  pi.registerTool({
    name: 'job_start',
    outputSchema: jobOutput,
    label: 'Start background job',
    description:
      'Start one background job: a worker in an isolated copy, verified by the host, then ' +
      'delivered. Returns at once; the outcome arrives by itself, so never poll or wait. Use ' +
      'it for every product change, for document work and for research worth a fresh context. ' +
      'Independent jobs can be started together from one codemode script; give each a key. ' +
      'Jobs do not reserve files: overlapping results surface as a conflict at delivery, so ' +
      'keep concurrent write scopes apart. Workers cannot install dependencies, reach the ' +
      'network or publish Git unless the user enrolled the project as trusted-local. Set ' +
      'isolation to required when the task or its inputs are external or untrusted. Set ' +
      'implementerModel only when the user asked for Opus or Fable to do the work.',
    parameters: startParameters,
    async execute(_id, input, _signal, _update, ctx) {
      if (!ctx.model) {
        throw new Error('Select a model first')
      }

      const store = jobStore(ctx.cwd)
      const root = await checkoutRoot(ctx, store, input.checkout)

      // Workers cannot install: a stale node_modules would fail every check that imports it.
      if (input.mode === 'implement') {
        await requireDependencies(root)
      }

      const { job, created } = store.createOnce({
        root,
        session: ctx.sessionManager.getSessionId(),
        spec: specFor(input, `${ctx.model.provider}/${ctx.model.id}`),
        key: input.key,
      })

      if (created) {
        await launch(store, job.id)
      }

      return structuredResult({
        ...jobView(job),
        next: 'Continue the conversation. The outcome arrives automatically.',
      })
    },
  })
  pi.registerTool({
    name: 'job_status',
    outputSchema: jobOutput,
    label: 'Read job status',
    description:
      'Read one job, with the output of its failed checks, or the recent jobs of this ' +
      'repository. This is a record lookup; outcomes are delivered without it.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'Job such as j12. Omit to list.' })),
    }),
    async execute(_id, { id }, _signal, _update, ctx) {
      const store = jobStore(ctx.cwd)
      store.reconcile()

      if (!id) {
        return structuredResult({ jobs: store.list({ limit: 30 }).map(jobView) })
      }

      const job = store.get(id)
      const receipts =
        (await readJson<Receipt[]>(join(jobDirectory(store, job.id), 'receipts.json'))) ?? []
      const failed = receipts.filter((receipt) => receipt.status !== 'passed').map(receiptView)
      return structuredResult({ ...jobView(job), ...(failed.length && { failedChecks: failed }) })
    },
  })
  pi.registerTool({
    name: 'job_message',
    outputSchema: jobOutput,
    label: 'Guide running job',
    description:
      'Send evidence or guidance to a queued or running job. Its worker reads it at the next ' +
      'safe boundary. Guidance cannot widen the write scope or change the checks.',
    parameters: Type.Object({
      id: Type.String(),
      text: Type.String({ minLength: 1, maxLength: 8000 }),
    }),
    async execute(_id, { id, text }, _signal, _update, ctx) {
      const store = jobStore(ctx.cwd)
      const job = store.get(id)

      if (job.status !== 'queued' && job.status !== 'running') {
        throw new Error(`Job ${jobLabel(job)} is ${job.status}; use job_retry with guidance`)
      }

      const worker = await activeWorker(job)

      try {
        if (!worker) {
          throw new Error('no worker is accepting guidance')
        }

        await new WorkerMailbox(worker).send(text, 'host')
        return structuredResult({ id: jobLabel(job), delivery: 'queued for the running worker' })
      } catch {
        store.addMessage(job.id, text)
        return structuredResult({ id: jobLabel(job), delivery: 'held for the next round' })
      }
    },
  })
  pi.registerTool({
    name: 'job_retry',
    outputSchema: jobOutput,
    label: 'Retry stopped job',
    description:
      'Run a needs_attention job again from the work it kept, with guidance on what to do ' +
      'differently. Do this after resolving what stopped it; an identical retry stops the ' +
      'same way. A job the user cancelled is retried only on a new request from the user.',
    parameters: Type.Object({
      id: Type.String(),
      guidance: Type.String({ minLength: 1, maxLength: 8000 }),
    }),
    async execute(_id, { id, guidance }, _signal, _update, ctx) {
      const store = jobStore(ctx.cwd)
      const job = store.requeue(store.get(id).id)
      store.addMessage(job.id, guidance)
      await launch(store, job.id)
      return structuredResult({ ...jobView(job), next: 'The outcome arrives automatically.' })
    },
  })
  pi.registerTool({
    name: 'job_close',
    outputSchema: jobOutput,
    label: 'Close stopped job',
    description:
      'Close a needs_attention job that will not be retried, with the reason: it was resolved ' +
      'another way, or the user decided against it. The user is shown the closure. A running ' +
      'job cannot be closed or cancelled by you: only the user stops work, with /jobs cancel.',
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    async execute(_id, { id, reason }, _signal, _update, ctx) {
      const store = jobStore(ctx.cwd)
      const job = store.get(id)

      if (job.status !== 'needs_attention') {
        throw new Error(
          `Job ${jobLabel(job)} is ${job.status}. Only a needs_attention job can be closed; ` +
            'the user stops running work with /jobs cancel.',
        )
      }

      const closed = store.update(job.id, { status: 'closed', phase: 'closed', summary: reason })
      ctx.ui.notify(`Job ${jobLabel(job)} (${job.spec.title}) closed: ${reason}`, 'info')
      return structuredResult(jobView(closed))
    },
  })
}

function describe(job: Job): string {
  const detail = job.status === 'running' ? job.phase : (job.error ?? job.summary ?? '')
  return `${jobLabel(job)}  ${job.status.padEnd(15)} ${job.spec.title}  ${detail.slice(0, 120)}`
}

/** The user's own controls. Cancelling is here and nowhere in the model's tools. */
function registerCommand(pi: ExtensionAPI) {
  pi.registerCommand('jobs', {
    description: 'Show jobs; "/jobs jN" for one in full, "/jobs cancel jN" to stop it',
    async handler(args, ctx) {
      const store = jobStore(ctx.cwd)
      const [first, second] = args.trim().split(/\s+/)

      try {
        if (!first) {
          const jobs = store.list({ limit: 20 })
          ctx.ui.notify(jobs.length ? jobs.map(describe).join('\n') : 'No jobs yet.', 'info')
        } else if (first === 'cancel' && second) {
          const job = store.requestCancel(store.get(second).id)
          ctx.ui.notify(
            job.status === 'running'
              ? `Stopping ${jobLabel(job)}; its work so far is kept.`
              : `${jobLabel(job)} is ${job.status}.`,
            'info',
          )
        } else if (!second) {
          ctx.ui.notify(JSON.stringify(jobView(store.get(first)), null, 2), 'info')
        } else {
          ctx.ui.notify('Usage: /jobs, /jobs jN or /jobs cancel jN. Nothing changed.', 'warning')
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })
}

export type JobOptions = { launch?: Launcher; tickMs?: number; retryMs?: number }

export function registerJobs(pi: ExtensionAPI, options: JobOptions = {}) {
  const feed = new JobFeed(pi, options.retryMs ?? 10000)
  let bootstrapRoot: string | undefined
  pi.on('session_start', (_event, ctx) => {
    feed.open(ctx)
    void sweepTemporary().catch(() => {})
  })
  pi.on('session_shutdown', () => feed.close())
  pi.on('before_agent_start', async (_event, ctx) => {
    bootstrapRoot = await freshBootstrapRoot(ctx.cwd)
    feed.current = ctx
    return openJobs(ctx)
  })

  // Only the latest statement of open jobs is current; older ones leave model context.
  pi.on('context', ({ messages }) => {
    const latest = messages.findLast(
      (message) => message.role === 'custom' && message.customType === openType,
    )
    const kept = messages.filter(
      (message) =>
        message === latest || message.role !== 'custom' || message.customType !== openType,
    )
    return kept.length === messages.length ? undefined : { messages: kept }
  })
  pi.on('turn_end', (event, ctx) => feed.boundary(event, ctx))
  pi.on('agent_before_settle', (event, ctx) => feed.boundary(event, ctx) ?? emptyAnswer(event))
  pi.on('agent_settled', (_event, ctx) => feed.idle(ctx))
  pi.on('tool_call', (event, ctx) => hostWriteBlock(event, ctx, bootstrapRoot))
  feed.observe(options.tickMs ?? 1000)
  registerTools(pi, options.launch ?? launchJob)
  registerCommand(pi)
}
