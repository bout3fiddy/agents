import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface MemoryFact {
  key: string
  revision: number
  kind: string
  text: string
  source: string
  quote: string
  paths: string[]
}
export interface PendingLine {
  key: string
  previous: string
  line: string
}
type StoredFact = Omit<MemoryFact, 'paths'> & { paths: string }

// One database per local clone. All worktrees use the same SQLite writer lock.
export class MemoryStore {
  private readonly db: DatabaseSync
  constructor(file: string, legacy?: string) {
    this.db = new DatabaseSync(file)

    try {
      this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY CHECK(id=1), paths TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        source TEXT NOT NULL, quote TEXT NOT NULL, paths TEXT NOT NULL,
        PRIMARY KEY(key,revision));
      CREATE TABLE IF NOT EXISTS hosts (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pending (
        key TEXT PRIMARY KEY, previous TEXT NOT NULL, line TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_conflicts AS SELECT * FROM facts WHERE 0;
      CREATE UNIQUE INDEX IF NOT EXISTS conflict_revision ON legacy_conflicts(key,revision);
      CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL);`)

      if (legacy && existsSync(legacy)) {
        this.importLegacy(legacy)
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private importLegacy(file: string) {
    this.db.prepare('ATTACH DATABASE ? AS legacy').run(pathToFileURL(file).href + '?mode=ro')

    try {
      const cursor = 'COALESCE((SELECT cursor FROM migration WHERE id=1),0)'
      const tip = 'COALESCE((SELECT MAX(rowid) FROM legacy.facts),0)'

      if (
        this.db.prepare(`SELECT ${cursor} = ${tip} AS caughtUp`).get()?.caughtUp &&
        this.db.prepare('SELECT id FROM migration').get()
      ) {
        return
      }

      // A live older host can finish a turn after the initial import. Divergent revisions are
      // retained as history without replacing the decision made in the upgraded harness.

      this.db.exec(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO legacy_conflicts
          SELECT l.* FROM legacy.facts l WHERE l.rowid > ${cursor} AND EXISTS (
            SELECT 1 FROM legacy.facts p JOIN main.facts f USING(key,revision)
            WHERE p.key=l.key AND p.revision<=l.revision AND
              (p.kind,p.text,p.source,p.quote,p.paths) IS NOT
              (f.kind,f.text,f.source,f.quote,f.paths));
        INSERT OR IGNORE INTO main.facts SELECT l.* FROM legacy.facts l WHERE l.rowid > ${cursor}
          AND NOT EXISTS (SELECT 1 FROM legacy_conflicts c WHERE c.key=l.key);
        INSERT OR IGNORE INTO hosts SELECT * FROM legacy.hosts;
        INSERT OR IGNORE INTO seed SELECT * FROM legacy.seed;
        INSERT OR REPLACE INTO migration VALUES(1,${tip});
        COMMIT;`)
    } finally {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }

      this.db.exec('DETACH DATABASE legacy')
    }
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
      .prepare(
        `SELECT *, 'current-store' AS origin FROM facts WHERE key=?
        UNION ALL SELECT *, 'legacy-conflict' AS origin FROM legacy_conflicts WHERE key=?
        ORDER BY revision DESC LIMIT 12`,
      )
      .all(key, key) as unknown as (StoredFact & { origin: string })[]
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

  publishPending(write: (rows: PendingLine[]) => string[]) {
    if (!this.db.prepare('SELECT 1 FROM pending LIMIT 1').get()) {
      return
    }

    this.db.exec('BEGIN IMMEDIATE')

    try {
      const rows = this.db.prepare('SELECT * FROM pending ORDER BY key').all()
      const keys = write(rows as unknown as PendingLine[])
      const drop = this.db.prepare('DELETE FROM pending WHERE key=?')

      for (const key of keys) {
        drop.run(key)
      }

      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  update(facts: MemoryFact[], portable: PendingLine[] = []) {
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

      const enqueue = this.db.prepare('INSERT OR REPLACE INTO pending VALUES(?,?,?)')

      for (const row of portable) {
        enqueue.run(row.key, row.previous, row.line)
      }

      this.db.exec('COMMIT')
      return recorded
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
