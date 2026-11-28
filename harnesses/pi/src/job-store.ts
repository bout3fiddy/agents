import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { invariant } from './invariant.ts'
import { StateStore } from './state.ts'
import type { Design, ImplementerModel, TaskIsolation, WorkerThinking } from './contracts.ts'

/** Raised when the schema changes shape. State written by another version is set aside. */
export const schemaVersion = 2

export const jobLimits = {

  /** Runner heartbeat period, and the silence after which a runner is taken for dead. */
  heartbeatMs: 2000,
  staleMs: 20000,
  summary: 4000,
  message: 8000,
}

export type JobMode = 'implement' | 'documents' | 'research'
export type JobDelivery = 'apply' | 'branch' | 'none'

/** What the host asked for. Fixed when the job is created; a retry reuses it unchanged. */
export type JobSpec = {
  title: string
  task: string
  mode: JobMode
  deliver: JobDelivery
  writePaths: string[]
  design?: Design

  /** Commit-ish the work starts from. Absent: the checkout's working tree as it stands. */
  base?: string

  /** Branch that receives the result when deliver is branch. */
  branch?: string
  thinking?: WorkerThinking
  implementerModel?: ImplementerModel
  isolation?: TaskIsolation

  /** Host model in provider/model form, inherited by roles that do not name their own. */
  model: string
}

export const activeStatuses = ['queued', 'running'] as const
export type JobStatus =
  (typeof activeStatuses)[number] | 'done' | 'needs_attention' | 'cancelled' | 'closed'

export type JobResult = {
  changed?: string[]
  checks?: { check: string; status: string }[]
  hostActions?: { capability: string; reason: string }[]
  findings?: string[]
  conflicts?: string[]
  model?: string
}

export type Job = {
  id: string
  number: number
  root: string
  session: string
  spec: JobSpec
  status: JobStatus
  phase: string
  round: number

  /** Commits in the repository's object store: where work started, its latest state, its result. */
  base?: string
  wip?: string
  head?: string
  pid?: number
  heartbeat?: number
  cancellation?: { by: 'user' | 'orchestrator'; reason: string; at: number }
  summary?: string
  error?: string
  result: JobResult
  createdAt: string
  updatedAt: string
}

export type JobEvent = {
  id: number
  job: string
  session: string
  type: 'outcome'
  at: string
}

type Row = Record<string, string | number | null>

/** The checkout that owns the repository's shared state: the primary one, or cwd without Git. */
export function primaryRoot(cwd: string): string {
  const root = realpathSync(cwd)

  try {
    const common = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return common.endsWith('/.git') ? realpathSync(dirname(common)) : root
  } catch {
    return root
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function toJob(row: Row): Job {
  const text = (name: string) => (row[name] === null ? undefined : String(row[name]))
  const number = (name: string) => (row[name] === null ? undefined : Number(row[name]))
  return {
    id: String(row.id),
    number: Number(row.number),
    root: String(row.root),
    session: String(row.session),
    spec: JSON.parse(String(row.spec)) as JobSpec,
    status: String(row.status) as JobStatus,
    phase: String(row.phase),
    round: Number(row.round),
    base: text('base'),
    wip: text('wip'),
    head: text('head'),
    pid: number('pid'),
    heartbeat: number('heartbeat'),
    cancellation: row.cancel === null ? undefined : JSON.parse(String(row.cancel)),
    summary: text('summary'),
    error: text('error'),
    result: JSON.parse(String(row.result)) as JobResult,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

const columns: Record<string, string> = {
  status: 'status',
  phase: 'phase',
  round: 'round',
  base: 'base',
  wip: 'wip',
  head: 'head',
  pid: 'pid',
  summary: 'summary',
  error: 'error',
}

export type JobPatch = Partial<
  Pick<Job, 'status' | 'phase' | 'round' | 'base' | 'wip' | 'head' | 'pid' | 'summary' | 'error'>
> & { result?: JobResult }

/**
 * Every job of one repository, in one SQLite file shared by all of its checkouts. Host sessions
 * and detached runners open it concurrently; each change is one transaction, so there is no
 * separate lock, journal or delivery receipt to reconcile.
 */
export class JobStore {
  readonly directory: string
  private readonly db: DatabaseSync

  constructor(
    readonly root: string,
    directory?: string,
  ) {
    this.directory = directory ?? new StateStore(root).directory
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.db = this.connect(join(this.directory, 'jobs.db'))
  }

  /** The store of the repository that cwd belongs to. */
  static open(cwd: string): JobStore {
    return new JobStore(primaryRoot(cwd))
  }

  private connect(path: string): DatabaseSync {
    let db = new DatabaseSync(path)
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    )
    const empty = !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs'").get()

    if (!empty && version !== schemaVersion) {

      // Another version wrote this file. Nothing is migrated: it is kept beside a fresh store.
      db.close()
      renameSync(path, `${path}.v${version}`)

      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(path + suffix)) {
          renameSync(path + suffix, `${path}.v${version}${suffix}`)
        }
      }

      db = new DatabaseSync(path)
    }

    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, root TEXT NOT NULL,
        session TEXT NOT NULL, key TEXT, spec TEXT NOT NULL, status TEXT NOT NULL,
        phase TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, base TEXT, wip TEXT, head TEXT,
        pid INTEGER, heartbeat INTEGER, cancel TEXT, summary TEXT,
        error TEXT, result TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(session, key));
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, session TEXT NOT NULL,
        type TEXT NOT NULL, at TEXT NOT NULL, acked_at TEXT);
      CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, text TEXT NOT NULL,
        at TEXT NOT NULL, taken_at TEXT);
      PRAGMA user_version = ${schemaVersion};`)
    return db
  }

  close() {
    if (this.db.isOpen) {
      this.db.close()
    }
  }

  /** One atomic change. A change made inside another joins the outer one. */
  private transaction<T>(action: () => T): T {
    if (this.db.isTransaction) {
      return action()
    }

    this.db.exec('BEGIN IMMEDIATE')

    try {
      const value = action()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Record a job. A key makes creation idempotent within its session: a script that runs twice,
   * or loops, gets the job it already started instead of a second one.
   */
  createOnce(
    input: { root: string; session: string; spec: JobSpec; key?: string },
    link?: (job: Job) => void,
  ): {
    job: Job
    created: boolean
  } {
    return this.transaction(() => {
      if (input.key) {
        const existing = this.db
          .prepare('SELECT * FROM jobs WHERE session = ? AND key = ?')
          .get(input.session, input.key) as Row | undefined

        if (existing) {
          return { job: toJob(existing), created: false }
        }
      }

      const next = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM jobs').get() as {
        n: number
      }
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO jobs(id, number, root, session, key, spec, status, phase, created_at,
             updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)`,
        )
        .run(
          id,
          next.n,
          input.root,
          input.session,
          input.key ?? null,
          JSON.stringify(input.spec),
          now,
          now,
        )
      const job = this.get(id)

      // Link a handoff before commit. A rejected link rolls back; a crash can leave an
      // undelivered link, never a launched job whose source cannot identify it.
      link?.(job)
      return { job, created: true }
    })
  }

  create(input: { root: string; session: string; spec: JobSpec; key?: string }): Job {
    return this.createOnce(input).job
  }

  /** Resolve a job by its UUID, a unique prefix of it, or its short form such as j12. */
  find(reference: string): Job | undefined {
    const short = /^j?(\d{1,9})$/i.exec(reference.trim())
    const rows = short
      ? this.db.prepare('SELECT * FROM jobs WHERE number = ?').all(Number(short[1]))
      : /^[a-f0-9-]{6,36}$/.test(reference)
        ? this.db.prepare('SELECT * FROM jobs WHERE id LIKE ?').all(reference + '%')
        : []
    return rows.length === 1 ? toJob(rows[0] as Row) : undefined
  }

  get(reference: string): Job {
    const job = this.find(reference)

    if (!job) {
      throw new Error(`No job ${reference}. job_status lists the jobs of this repository.`)
    }

    return job
  }

  list(filter: { session?: string; open?: boolean; limit?: number } = {}): Job[] {
    const where: string[] = []
    const values: (string | number)[] = []

    if (filter.session) {
      where.push('session = ?')
      values.push(filter.session)
    }

    if (filter.open) {
      where.push("status IN ('queued', 'running', 'needs_attention')")
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY number DESC LIMIT ?`,
      )
      .all(...values, filter.limit ?? 200)
    return (rows as Row[]).map(toJob)
  }

  update(id: string, patch: JobPatch): Job {
    const sets = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    for (const [name, value] of Object.entries(patch)) {
      if (name === 'result') {
        sets.push('result = ?')
        values.push(JSON.stringify(value))
      } else {
        invariant(columns[name], `unknown job column ${name}`)
        sets.push(`${columns[name]} = ?`)
        values.push(
          typeof value === 'string' ? value.slice(0, 16000) : ((value as number | null) ?? null),
        )
      }
    }

    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.get(id)
  }

  /** Fence a lost launch: a late runner can no longer claim it. A running job is untouched. */
  failUnclaimed(id: string) {
    return this.transaction(() => {
      const job = this.get(id)
      return job.status === 'queued'
        ? this.finish(id, 'needs_attention', { error: 'Job launch did not complete.' })
        : job
    })
  }

  /** A runner takes a queued job. False when another runner, or a cancellation, got there first. */
  claim(id: string, pid: number): boolean {
    const outcome = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', phase = 'starting', pid = ?, heartbeat = ?,
           error = NULL, updated_at = ? WHERE id = ? AND status = 'queued' AND cancel IS NULL`,
      )
      .run(pid, Date.now(), new Date().toISOString(), id)
    return Number(outcome.changes) === 1
  }

  /** Beat, and report whether this attempt has a stop request. */
  heartbeat(id: string): boolean {
    const row = this.db
      .prepare('UPDATE jobs SET heartbeat = ? WHERE id = ? RETURNING cancel')
      .get(Date.now(), id)
    return row?.cancel != null
  }

  /**
   * End a run. The outcome event is written with the status in one transaction, so a job can
   * never be finished without its session having something to be told.
   */
  finish(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, patch: JobPatch = {}): Job {
    return this.transaction(() => {
      const current = this.get(id)

      // Two observers can find the same dead runner. The first to finish it wins.
      if (current.status !== 'queued' && current.status !== 'running') {
        return current
      }

      // A committed delivery wins a late stop. Otherwise honour the stop even if the worker
      // returned or failed before its next heartbeat observed the request.
      if (current.cancellation && status !== 'done') {
        status = 'cancelled'
        patch = { ...patch, summary: current.cancellation.reason }
      }

      const job = this.update(id, { ...patch, status, phase: status })
      this.db.prepare('UPDATE jobs SET pid = NULL WHERE id = ?').run(id)
      this.db
        .prepare("INSERT INTO events(job, session, type, at) VALUES (?, ?, 'outcome', ?)")
        .run(id, job.session, new Date().toISOString())
      return this.get(id)
    })
  }

  /** Put a stopped job back in the queue for another run from its latest commit. */
  requeue(id: string, guidance?: string, lastUserAt = 0): Job {
    return this.transaction(() => {
      const job = this.get(id)

      if (job.status !== 'needs_attention' && job.status !== 'cancelled') {
        throw new Error(`Job j${job.number} is ${job.status}; only a stopped job can be retried`)
      }

      if (job.cancellation?.by === 'user' && !(lastUserAt > job.cancellation.at)) {
        throw new Error('The user stopped this job; retry only on a new request from the user.')
      }

      // No old outcome may wake the host describing the new attempt as finished.
      this.db.prepare('DELETE FROM events WHERE job = ? AND acked_at IS NULL').run(id)
      this.db.prepare('UPDATE jobs SET cancel = NULL, pid = NULL WHERE id = ?').run(id)

      if (guidance) {
        this.addMessage(id, guidance)
      }

      return this.update(id, { status: 'queued', phase: 'queued', summary: undefined })
    })
  }

  /** Only a queued job ends here. A running job's owner finishes it and emits the event. */
  requestCancel(id: string, reason?: string): Job {
    return this.transaction(() => {
      const job = this.get(id)
      const manual = reason === undefined
      const active = job.status === 'queued' || job.status === 'running'

      if (!active && !(manual && job.status === 'cancelled')) {
        return job
      }

      if (!manual && job.cancellation) {
        return job
      }

      const why = manual ? 'Stopped by the user.' : reason.trim()

      if (!why || why.length > 1000) {
        throw new Error('Give a cancellation reason of 1 to 1000 characters.')
      }

      const cancellation = { by: manual ? 'user' : 'orchestrator', reason: why, at: Date.now() }
      this.db
        .prepare('UPDATE jobs SET cancel = ? WHERE id = ?')
        .run(JSON.stringify(cancellation), id)

      if (job.status === 'queued') {
        return this.finish(id, 'cancelled')
      }

      return job.status === 'cancelled' ? this.update(id, { summary: why }) : this.get(id)
    })
  }

  /** Runners that died without finishing leave their job for the host, with its work kept. */
  reconcile(now = Date.now()): Job[] {
    const lost: Job[] = []

    for (const job of this.list({ open: true })) {
      const silent = now - (job.heartbeat ?? Date.parse(job.updatedAt)) > jobLimits.staleMs

      if (job.status === 'running' && silent && !(job.pid && processAlive(job.pid))) {
        this.transaction(() => {
          const current = this.get(job.id)

          if (
            current.status === 'running' &&
            current.pid === job.pid &&
            current.heartbeat === job.heartbeat
          ) {
            lost.push(
              this.finish(job.id, 'needs_attention', {
                error: 'The job runner stopped before finishing. Its latest work is kept.',
              }),
            )
          }
        })
      }
    }

    return lost
  }

  /** Outcomes a session has not yet been shown, oldest first. */
  pendingEvents(session: string): JobEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE session = ? AND acked_at IS NULL ORDER BY id')
      .all(session) as JobEvent[]
  }

  acknowledge(ids: number[]) {
    const at = new Date().toISOString()

    for (const id of ids) {
      this.db
        .prepare('UPDATE events SET acked_at = ? WHERE id = ? AND acked_at IS NULL')
        .run(at, id)
    }
  }

  /** Guidance for a job with no worker to hand it to yet. The next round reads it. */
  addMessage(id: string, text: string) {
    this.db
      .prepare('INSERT INTO messages(job, text, at) VALUES (?, ?, ?)')
      .run(id, text.slice(0, jobLimits.message), new Date().toISOString())
  }

  takeMessages(id: string): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, text FROM messages WHERE job = ? AND taken_at IS NULL ORDER BY id')
        .all(id) as { id: number; text: string }[]
      this.db
        .prepare('UPDATE messages SET taken_at = ? WHERE job = ? AND taken_at IS NULL')
        .run(new Date().toISOString(), id)
      return rows.map((row) => row.text)
    })
  }
}

export const jobLabel = (job: Pick<Job, 'number'>) => `j${job.number}`

export function jobDirectory(store: JobStore, id: string): string {
  return join(store.directory, 'jobs', id)
}

/** What the host model is shown of a job: enough to decide the next step, nothing to re-derive. */
export function jobView(job: Job) {
  return {
    id: jobLabel(job),
    title: job.spec.title,
    mode: job.spec.mode,
    deliver: job.spec.deliver,
    status: job.status,
    phase: job.phase,
    ...(job.cancellation && { cancellation: job.cancellation }),
    round: job.round,
    ...(job.root && { checkout: job.root }),
    ...(job.spec.branch && job.spec.deliver === 'branch' && { branch: job.spec.branch }),
    ...(job.head && { commit: job.head }),
    ...(job.summary && { summary: job.summary.slice(0, jobLimits.summary) }),
    ...(job.error && { error: job.error.slice(0, jobLimits.summary) }),
    ...job.result,
  }
}
