import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkerEvidence, WorkerResult } from '../src/contracts.ts'
import { bindFormatterProof, formatterClosures } from '../src/formatter-review.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { databaseImpact, runWorkflow } from '../src/workflow.ts'
import { evidence, fixture } from './support.ts'

const note = 'src/guide.md'
const formatted = '# Guide\n\n```ts\nsubmit(work)\n```\n'
const original = formatted.replace('submit(work)', 'submit(work);')
const finding = {
  severity: 'required' as const,
  location: note + ':4',
  problem: 'Trailing semicolon in the formatted example.',
  evidence: 'Repository formatter removes only the semicolon.',
  formatterPath: note,
}
const changesRequested: Partial<WorkerResult> = {
  verdict: 'changes',
  findings: [finding],
  hostActions: [{ capability: 'git', reason: 'Run the project index check on the host' }],
}

test('DB review follows changed persistence code, removed adapters and configured scopes', () => {
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

test('formatter closure requires all findings and the entire reviewed tree', async (t) => {
  const { root, base } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  await writeFile(join(root, note), original)
  const before = await inventory(root)
  const after = new Map(before).set(note, Buffer.from(formatted))
  const review: WorkerEvidence = {
    role: 'reviewer',
    model: 'claude-cli/test',
    turns: 1,
    commands: [],
    snapshot: snapshotHash(before),
    result: {
      verdict: 'changes',
      summary: 'Format the example',
      findings: [finding],
      evidence: [],
      databaseImpact: false,
    },
  }
  const mixed = structuredClone(review)
  mixed.result.findings.push({ ...finding, formatterPath: undefined, problem: 'Fix the behavior' })
  await bindFormatterProof(mixed, before, root, ['src/**'])
  assert.deepEqual(formatterClosures([mixed], after), [])
  const behavioral = structuredClone(review)
  delete behavioral.result.findings[0]!.formatterPath
  await bindFormatterProof(behavioral, before, root, ['src/**'])
  assert.equal(behavioral.formatterProof, undefined)
  await bindFormatterProof(review, before, root, ['other/**'])
  assert.equal(review.formatterProof, undefined)
  await writeFile(join(root, '.prettierignore'), note + '\n')
  await bindFormatterProof(review, before, root, ['src/**'])
  assert.equal(review.formatterProof, undefined)
  await rm(join(root, '.prettierignore'))
  await bindFormatterProof(review, before, root, ['src/**'])
  assert.ok(review.formatterProof)
  assert.deepEqual(formatterClosures([review], before), [])
  assert.deepEqual(
    formatterClosures([review], new Map(after).set('unrelated', Buffer.alloc(0))),
    [],
  )
  assert.deepEqual(
    formatterClosures([review], new Map(after).set(note, Buffer.from('# Other'))),
    [],
  )
  assert.deepEqual(formatterClosures([review, behavioral], after), [])
  const [closure] = formatterClosures([review], after)
  assert.equal(closure?.snapshot, snapshotHash(after))
  assert.equal(closure?.closedReview?.snapshot, review.snapshot)
  assert.equal(closure?.turns, 0)
  assert.equal(review.result.verdict, 'changes')
})

test('workflow closes formatting and preserves paired review and checks', async (t) => {
  const { store, base, root } = await fixture({ database: true })
  t.after(() => rm(base, { recursive: true, force: true }))
  let implementations = 0
  const reviewed: string[] = []
  const result = await runWorkflow(store, 'fixture/model', undefined, async (request) => {
    if (request.role === 'implementer') {
      await writeFile(join(request.workspace, note), implementations++ ? formatted : original)
    } else {
      reviewed.push(request.role)
    }

    return evidence(request, request.role === 'reviewer' ? changesRequested : {})
  })
  assert.equal(result.status, 'complete', result.error)
  assert.deepEqual(reviewed.sort(), ['database-reviewer', 'reviewer'])
  const closures = result.evidence.filter((worker) => worker.closedReview)
  assert.equal(closures.length, 2)
  assert.ok(closures.every((worker) => worker.snapshot === result.snapshot))
  assert.deepEqual(
    closures.find((r) => r.role === 'reviewer')?.result.hostActions,
    changesRequested.hostActions,
  )
  assert.ok(result.receipts.some((r) => r.check === 'recovery' && r.status === 'passed'))
  assert.ok(result.receipts.every((r) => r.snapshot === result.snapshot))
  assert.equal((await inventory(root)).get(note)?.toString(), formatted)
})
