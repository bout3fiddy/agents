import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { invariant } from './invariant.ts'
import { installPath } from './pi-host.ts'

export const leaseMs = 30_000
const namePattern = /^[a-z][a-z0-9-]{0,39}$/
export type Intent = 'discuss' | 'build'
type Project = {
  name: string
  root: string
  identity: string
  token: string
  pid: number
  beat: number
  ready: number
}
export type Request = {
  id: string
  source: string
  session: string
  dest: string
  intent: Intent
  brief: string
  key: string
  token: string
  state: 'queued' | 'handling' | 'job' | 'done' | 'failed'
  reply: string
  job: string
}
export type StartReceiver = (root: string, token: string) => number

function contains(parent: string, path: string) {
  const rel = relative(parent, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function identity(root: string) {
  const stat = statSync(root, { bigint: true })

  if (!stat.isDirectory() || realpathSync(root) !== root) {
    throw new Error('Checkout root changed')
  }

  return `${stat.dev}:${stat.ino}`
}

function live(p: Project, now: number) {
  if (!p.token || p.beat + leaseMs <= now || p.beat > now || p.pid <= 0) {
    return false
  }

  try {
    process.kill(p.pid, 0)
    return true
  } catch (error) {

    // Signal permission and process existence are separate; the lease still has to be fresh.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return true
    }

    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }

    return false
  }
}

/** This database routes between checkouts; jobs and their receipts stay in the job store. */
export class HandoffStore {
  private constructor(
    private db: DatabaseSync,
    readonly agentDir: string,
    private now: () => number,
  ) {}

  static open(agent = dirname(installPath()), create = false, now = Date.now) {
    const dir = join(agent, 'handoffs-v1')
    const path = join(dir, 'mail.sqlite')

    if (!create && !existsSync(path)) {
      return undefined
    }

    if (create) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }

    const metadata = lstatSync(dir)

    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) {
      throw new Error('Handoff directory must be private and owned by the user')
    }

    if (create) {
      closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
    }

    const file = lstatSync(path)

    if (!file.isFile() || file.nlink !== 1 || file.uid !== metadata.uid || file.mode & 0o077) {
      throw new Error('Unsafe handoff database')
    }

    const db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 2000')

    if (!create && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()) {
      db.close()
      return undefined
    }

    if (create) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS projects(name TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL,
        identity TEXT NOT NULL, token TEXT DEFAULT '', pid INTEGER DEFAULT 0,
        beat INTEGER DEFAULT 0, ready INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, source TEXT NOT NULL,
        session TEXT NOT NULL, key TEXT NOT NULL, dest TEXT NOT NULL, intent TEXT NOT NULL,
        brief TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        job TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '', notified INTEGER DEFAULT 0,
        UNIQUE(source,key));
    `)
    }

    return new HandoffStore(db, realpathSync(agent), now)
  }

  close() {
    this.db.close()
  }

  private atomic<T>(op: () => T) {
    this.db.exec('BEGIN IMMEDIATE')

    try {
      const value = op()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  enroll(root: string, name: string) {
    if (!namePattern.test(name)) {
      throw new Error('Use a short lowercase project name')
    }

    root = realpathSync(root)

    if (contains(root, this.agentDir) || contains(this.agentDir, root)) {
      throw new Error('A project must be separate from the private agent directory')
    }

    const fingerprint = identity(root)
    this.atomic(() => {
      if (this.local(root)?.name === name) {
        return
      }

      if (this.list().length >= 128) {
        throw new Error('Project capacity reached')
      }

      this.db
        .prepare('INSERT INTO projects(name,root,identity) VALUES(?,?,?)')
        .run(name, root, fingerprint)
    })
  }

  leave(root: string, name: string) {
    this.atomic(() => {
      if (this.local(root)?.name !== name) {
        throw new Error('Alias does not match this checkout')
      }

      if (
        this.db.prepare('SELECT 1 FROM requests WHERE source=? OR dest=? LIMIT 1').get(name, name)
      ) {
        throw new Error('Collect and forget retained requests at their sources before leaving')
      }

      this.db.prepare('DELETE FROM projects WHERE name=?').run(name)
    })
  }

  local(cwd: string) {
    const root = realpathSync(cwd)
    const p = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root) as
      Project | undefined

    if (p && p.identity !== identity(root)) {
      throw new Error('Enrolled checkout was replaced')
    }

    return p
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[]
    return rows.map((p) => ({
      name: p.name,
      presence: live(p, this.now()) ? (p.ready ? 'live' : 'starting') : 'offline',
    }))
  }

  private retire(p: Project, reason: string) {
    this.db
      .prepare(
        `UPDATE requests SET state='failed',reply=? WHERE dest=? AND token=?
      AND state IN ('queued','handling')`,
      )
      .run(reason, p.name, p.token)
  }

  private selectOwner(p: Project, token: string, pid: number, ready: number) {
    invariant(this.db.isTransaction, 'Receiver election must serialize with admission')
    invariant(token.length > 0 && Number.isSafeInteger(pid) && pid > 0, 'Invalid receiver identity')
    this.retire(p, 'Previous receiver stopped. Inspect destination jobs before any new send.')
    this.db
      .prepare('UPDATE projects SET token=?,pid=?,ready=?,beat=? WHERE name=?')
      .run(token, pid, ready, this.now(), p.name)
  }

  /** Reserve a launch and enqueue in one transaction. No message field is an executable or path. */
  send(
    cwd: string,
    session: string,
    dest: string,
    key: string,
    intent: Intent,
    brief: string,
    start: StartReceiver,
  ) {
    if (
      !['discuss', 'build'].includes(intent) ||
      !brief.trim() ||
      brief.length > 8000 ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(key)
    ) {
      throw new Error('Invalid project request')
    }

    return this.atomic(() => {
      const source = this.local(cwd)?.name
      const p = this.db.prepare('SELECT * FROM projects WHERE name=?').get(dest) as
        Project | undefined

      if (!source || !p || source === dest) {
        throw new Error('Two different enrolled projects required')
      }

      const prior = this.db
        .prepare('SELECT * FROM requests WHERE source=? AND key=?')
        .get(source, key) as Request | undefined

      if (prior) {
        if (prior.dest !== dest || prior.brief !== brief || prior.intent !== intent) {
          throw new Error('Request key already used with different content')
        }

        return prior.id
      }

      const count = this.db.prepare('SELECT count(*) AS n FROM requests').get()!.n

      if (Number(count) >= 1024) {
        throw new Error('Mailbox full; forget collected terminal requests')
      }

      if (identity(p.root) !== p.identity) {
        throw new Error('Destination checkout was replaced')
      }

      const id = randomUUID()
      let token = p.token
      let failure = ''

      if (!live(p, this.now())) {
        token = randomUUID()

        let pid: number | undefined

        try {
          pid = start(p.root, token)
        } catch {
          failure = 'Launch failed. Check the installed pih wrapper and destination permissions.'
        }

        if (pid !== undefined) {
          this.selectOwner(p, token, pid, 0)
        }
      }

      this.db
        .prepare(
          `INSERT INTO requests(id,source,session,key,dest,intent,brief,token,state,reply)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          source,
          session,
          key,
          dest,
          intent,
          brief,
          token,
          failure ? 'failed' : 'queued',
          failure,
        )
      return id
    })
  }

  /** A cold process must redeem its exact reservation; an interactive host may elect itself. */
  heartbeat(cwd: string, token: string, cold: boolean, expectedName?: string) {
    return this.atomic(() => {
      const p = this.local(cwd)

      if (!p || (expectedName !== undefined && expectedName !== p.name)) {
        return false
      }

      if (p.token !== token) {
        if (cold || live(p, this.now())) {
          return false
        }

        this.selectOwner(p, token, process.pid, 1)
      } else {
        if (p.pid !== process.pid) {
          return false
        }

        if (!live(p, this.now())) {
          this.retire(p, 'Receiver lease expired; no automatic retry.')
          this.db.prepare("UPDATE projects SET token='',ready=0 WHERE name=?").run(p.name)
          return false
        }

        if (!p.ready || this.now() - p.beat >= leaseMs / 6) {
          this.db.prepare('UPDATE projects SET ready=1,beat=? WHERE name=?').run(this.now(), p.name)
        }
      }

      return true
    })
  }

  claim(dest: string, token: string) {
    return this.db
      .prepare(
        `UPDATE requests SET state='handling' WHERE id=(SELECT id FROM requests
      WHERE dest=? AND token=? AND state='queued' ORDER BY rowid LIMIT 1)
      AND EXISTS(SELECT 1 FROM projects WHERE name=? AND token=? AND ready=1 AND pid=?)
      RETURNING *`,
      )
      .get(dest, token, dest, token, process.pid) as Request | undefined
  }

  finish(id: string, state: 'done' | 'failed', reply: string) {
    this.db
      .prepare(`UPDATE requests SET state=?,reply=? WHERE id=? AND state IN ('handling','job')`)
      .run(state, reply.slice(0, 4000), id)
  }

  failHandling(id: string, reason: string) {
    this.db
      .prepare("UPDATE requests SET state='failed',reply=? WHERE id=? AND state='handling'")
      .run(reason, id)
  }

  attach(id: string, job: string) {
    this.atomic(() => {
      const owner = this.db
        .prepare(
          `SELECT p.* FROM projects p JOIN requests r
        ON p.name=r.dest AND p.token=r.token WHERE r.id=? AND r.state='handling'`,
        )
        .get(id) as Project | undefined

      if (
        !owner ||
        owner.pid !== process.pid ||
        !live(owner, this.now()) ||
        identity(owner.root) !== owner.identity
      ) {
        throw new Error('Request lost its receiver before launch')
      }

      this.db.prepare("UPDATE requests SET state='job',job=? WHERE id=?").run(job, id)
    })
  }

  jobs(dest: string) {
    return this.db
      .prepare("SELECT id,job FROM requests WHERE dest=? AND state='job'")
      .all(dest) as Pick<Request, 'id' | 'job'>[]
  }

  release(name: string, token: string, onlyIdle: boolean) {
    return this.atomic(() => {
      const p = this.db.prepare('SELECT * FROM projects WHERE name=?').get(name) as
        Project | undefined

      if (!p || p.token !== token || p.pid !== process.pid) {
        return true
      }

      if (
        onlyIdle &&
        this.db
          .prepare(
            `SELECT 1 FROM requests WHERE dest=?
        AND state IN ('queued','handling','job') LIMIT 1`,
          )
          .get(p.name)
      ) {
        return false
      }

      this.retire(p, 'Receiver stopped. Inspect destination jobs before a new send.')
      this.db.prepare("UPDATE projects SET token='',ready=0 WHERE name=?").run(p.name)
      return true
    })
  }

  observe(cwd: string, id: string) {
    const source = this.local(cwd)?.name ?? ''
    const r = this.db.prepare('SELECT * FROM requests WHERE source=? AND id=?').get(source, id) as
      Request | undefined

    if (!r) {
      throw new Error('Unknown request at this source')
    }

    const p = this.db.prepare('SELECT * FROM projects WHERE name=?').get(r.dest) as Project
    const online = live(p, this.now())
    const offline = !online || r.token !== p.token
    const state = offline && ['queued', 'handling'].includes(r.state) ? 'interrupted' : r.state
    return {
      id,
      destination: r.dest,
      state,
      receiver: online ? (p.ready ? 'live' : 'starting') : 'offline',
      job: r.job || undefined,
      reply: r.reply || undefined,
    }
  }

  recent(source: string, session: string) {

    // Reconcile failed launches even if the destination died before its first heartbeat.
    const destinations = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM projects p JOIN requests r
      ON r.dest=p.name WHERE r.source=? AND r.session=? AND r.state IN ('queued','handling')`,
      )
      .all(source, session) as Project[]

    for (const p of destinations) {
      if (!live(p, this.now())) {
        this.atomic(() => {
          const latest = this.db
            .prepare('SELECT * FROM projects WHERE name=?')
            .get(p.name) as Project

          if (!live(latest, this.now())) {
            this.retire(
              latest,
              latest.ready
                ? 'Receiver interrupted; inspect before retry.'
                : 'Launch interrupted. Check installed pih and checkout permissions.',
            )
            this.db.prepare("UPDATE projects SET token='',ready=0 WHERE name=?").run(p.name)
          }
        })
      }
    }

    return this.db
      .prepare(
        `SELECT id FROM requests WHERE source=? AND session=?
      AND notified=0 AND state IN ('done','failed') ORDER BY rowid`,
      )
      .all(source, session) as { id: string }[]
  }

  acknowledge(source: string, session: string, id: string) {
    this.db
      .prepare('UPDATE requests SET notified=1 WHERE source=? AND session=? AND id=?')
      .run(source, session, id)
  }

  forget(cwd: string, id: string) {
    this.atomic(() => {
      const status = this.observe(cwd, id)

      if (!['done', 'failed', 'interrupted'].includes(status.state)) {
        throw new Error('Request is active')
      }

      this.db.prepare('DELETE FROM requests WHERE id=?').run(id)
    })
  }
}
