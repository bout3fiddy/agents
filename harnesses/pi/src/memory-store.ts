import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { digest } from './paths.ts'

export interface MemoryFact {
  key: string
  revision: number
  kind: string
  text: string
  source: string
  quote: string
  paths: string[]
}
type StoredFact = Omit<MemoryFact, 'paths'> & { paths: string }

// One database per local clone. All worktrees use the same SQLite writer lock.
export class MemoryStore {
  private readonly db: DatabaseSync
  constructor(
    identity: string,
    dir = process.env.PI_HARNESS_AGENT_DIR ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), '.pi', 'agent'),
  ) {
    const folder = join(dir, 'project-memory', digest(identity))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(folder, 'memory.sqlite'))
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY CHECK(id=1), paths TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        source TEXT NOT NULL, quote TEXT NOT NULL, paths TEXT NOT NULL,
        PRIMARY KEY(key,revision));
      CREATE TABLE IF NOT EXISTS hosts (path TEXT PRIMARY KEY);`)
  }

  close() {
    this.db.close()
  }

  sources(): string[] | undefined {
    const row = this.db.prepare('SELECT paths FROM seed WHERE id=1').get()
    return row && JSON.parse(String(row.paths))
  }

  seed(paths: string[]) {
    this.db.prepare('INSERT OR IGNORE INTO seed VALUES(1,?)').run(JSON.stringify(paths))
  }

  host(path: string) {
    if (!this.db.prepare('SELECT 1 FROM hosts WHERE path=?').get(path)) {
      this.db.prepare('INSERT OR IGNORE INTO hosts VALUES(?)').run(path)
    }
  }

  hosts() {
    return this.db
      .prepare('SELECT path FROM hosts')
      .all()
      .map((row) => String(row.path))
  }

  history(key: string) {
    return this.db
      .prepare('SELECT * FROM facts WHERE key=? ORDER BY revision DESC LIMIT 12')
      .all(key)
  }

  facts(): MemoryFact[] {
    return (
      this.db
        .prepare(
          `SELECT f.* FROM facts f WHERE revision =
      (SELECT MAX(revision) FROM facts WHERE key=f.key) ORDER BY key`,
        )
        .all() as unknown as StoredFact[]
    ).map((row) => ({ ...row, paths: JSON.parse(row.paths) }))
  }

  update(facts: MemoryFact[]) {
    const recorded: { key: string; revision: number }[] = []
    this.db.exec('BEGIN IMMEDIATE')

    try {
      const current = this.db.prepare(
        'SELECT * FROM facts WHERE key=? ORDER BY revision DESC LIMIT 1',
      )
      const insert = this.db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?,?)')

      for (const fact of facts) {
        const old = current.get(fact.key)
        const paths = JSON.stringify(fact.paths)

        if (
          old?.text === fact.text &&
          old.kind === fact.kind &&
          old.paths === paths &&
          old.source === fact.source &&
          old.quote === fact.quote
        ) {
          recorded.push({ key: fact.key, revision: Number(old.revision) })
          continue
        }

        if ((old?.revision ?? 0) !== fact.revision) {
          throw new Error(
            'Project memory changed concurrently. Reconcile with ' + JSON.stringify(old),
          )
        }

        insert.run(
          fact.key,
          fact.revision + 1,
          fact.kind,
          fact.text,
          fact.source,
          fact.quote,
          paths,
        )
        recorded.push({ key: fact.key, revision: fact.revision + 1 })
      }

      this.db.exec('COMMIT')
      return recorded
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
