import assert from 'node:assert/strict'
import test from 'node:test'
import { databaseImpact } from '../src/job-checks.ts'

test('DB checks follow persistence code, removed adapters and configured scopes', () => {
  const detect = (path: string, before: string, after: string, scopes: string[] = []) =>
    databaseImpact(
      new Map(before ? [[path, Buffer.from(before)]] : []),
      new Map(after ? [[path, Buffer.from(after)]] : []),
      scopes,
    )
  const guide = '| postgres/backup.conf | Durable WAL |\n'
  assert.equal(detect('docs/plan.md', guide, guide + 'Updated verification.\n'), false)
  assert.equal(detect('docs/plan.md', '', 'CREATE TABLE jobs and run PostgreSQL.'), false)
  assert.equal(detect('docs/recovery.md', '', 'New RPO', ['docs/recovery.md']), true)
  assert.equal(detect('app/view.ts', 'log("postgres")', 'log("redis")'), false)

  for (const [path, contents] of [
    ['app/store.ts', 'import { Pool } from "pg"'],
    ['ops/backup.py', 'from sqlite3 import connect'],
    ['bundle/store.js', 'const sql = require("better-sqlite3")'],
    ['deploy/compose.yml', 'image: postgres:18'],
    ['package.json', '{"dependencies":{"@prisma/client":"1.0.0"}}'],
    ['requirements.txt', 'psycopg[binary]==3.2.0'],
    ['app/cache.ts', 'import { Redis } from "@upstash/redis"'],
    ['app/query.ts', 'await db.transaction(run)'],
    ['app/ddl.ts', 'ALTER TABLE jobs DROP COLUMN stale'],
    ['packages/data/drop.sql', 'DROP VIEW recent'],
  ] as const) {
    assert.ok(detect(path, '', contents), path)
    assert.ok(detect(path, contents, ''), 'removed ' + path)
  }

  const annotation = '    @notice Select the next item from the queue.'
  const contract = 'contract/queue.vy'
  assert.equal(detect(contract, '', annotation), false)
  assert.ok(detect(contract, '', annotation, ['contract/**']))
  assert.ok(detect('src/query.py', '', 'sql = "SELECT item FROM queue"'))

  const header = "// Shared UI utility.\r\n// Select the kind from the field's meaning.\r\n"
  assert.equal(detect('ui/link.ts', '', header + 'export const base = url'), false)
  assert.equal(detect('ui/link.ts', header, ''), false)
  assert.ok(detect('ui/link.ts', '', header + "const query = 'SELECT id FROM job'"))
  assert.ok(detect('ui/link.ts', '', header, ['ui/**']))
  assert.ok(detect('ui/link.js', '', 'const sql = `\nSELECT id FROM job\n`'))

  const loader = 'import { Pool } from "pg"\n'
  assert.ok(detect('src/loader.ts', loader + 'return tx(a)', loader + 'return tx(b)'))
  assert.ok(detect('storage/lease.go', 'return 1', 'return 2', ['storage/**']))
})
