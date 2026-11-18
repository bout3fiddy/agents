import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore } from '../src/state.ts'
import { projectTraces, shouldMirrorSession } from '../src/traces.ts'
import { inventory, safePath, sensitive } from '../src/paths.ts'
import { design } from './support.ts'

test('project traces stay local, ignored and excluded from worker snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-traces-'))

  try {
    const store = new StateStore(root)
    assert.equal(store.directory, join(store.projectRoot, '.pi/traces/harness'))
    await store.draft(design)
    await store.accept()
    assert.match(await readFile(join(store.directory, 'accepted.json'), 'utf8'), /bounded/)
    const ignore = join(root, '.pi/.gitignore')
    assert.equal(await readFile(ignore, 'utf8'), '/traces/\n')
    projectTraces(root)
    assert.equal(await readFile(ignore, 'utf8'), '/traces/\n')
    projectTraces(root, true)
    projectTraces(root, true)
    assert.equal(await readFile(ignore, 'utf8'), '/traces/\n/audit/\n/audits/\n')
    await promisify(execFile)('git', ['init', '-q', root])
    const ignored = await promisify(execFile)(
      'git',
      [
        'check-ignore',
        '.pi/traces/harness/accepted.json',
        '.pi/audit/test.json',
        '.pi/audits/progress/a.md',
      ],
      { cwd: root },
    )
    assert.match(ignored.stdout, /accepted.json/)
    assert.match(ignored.stdout, /audit\/test.json/)
    assert.match(ignored.stdout, /audits\/progress\/a.md/)
    assert.equal(sensitive('.PI/AUDITS/progress/a.md'), true)
    const files = await inventory(root)
    assert.ok(![...files.keys()].some((path) => path.includes('traces/')))
    assert.equal(sensitive('.PI/TRACES/harness/accepted.json'), true)
    await assert.rejects(safePath(root, '.pi/traces/harness/accepted.json'), /unavailable/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session mirrors recognize filesystem aliases and never replace the live writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-traces-'))

  try {
    const source = join(root, 'Session.jsonl')
    const alias = join(root, 'alias.jsonl')
    const other = join(root, 'other.jsonl')
    await writeFile(source, 'session\n')
    await link(source, alias)
    assert.equal(await shouldMirrorSession(source, source), false)
    assert.equal(await shouldMirrorSession(source, alias), false)
    assert.equal(await shouldMirrorSession(source, other), true)
    assert.equal(await shouldMirrorSession(other, source), false)

    // The runtime targets macOS; also exercise its default case-insensitive filename alias.

    if (process.platform === 'darwin') {
      assert.equal(await shouldMirrorSession(source, join(root, 'SESSION.JSONL')), false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('trace setup preserves ignore rules and rejects symlink destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-traces-'))

  try {
    projectTraces(root)
    const ignore = join(root, '.pi/.gitignore')
    await writeFile(ignore, 'existing-rule')
    projectTraces(root)
    assert.equal(await readFile(ignore, 'utf8'), 'existing-rule\n/traces/\n')
    await rm(join(root, '.pi/traces'), { recursive: true })
    await symlink(tmpdir(), join(root, '.pi/traces'))
    assert.throws(() => projectTraces(root), /real directories/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
