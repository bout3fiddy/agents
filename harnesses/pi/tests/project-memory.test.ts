import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import {
  briefName,
  portableLine,
  readBrief,
  repositoryStore,
  syncBrief,
} from '../src/memory-files.ts'
import { MemoryStore, type MemoryFact } from '../src/memory-store.ts'
import { memoryRepository, discoverSources } from '../src/memory-repository.ts'
import { registerProjectMemory } from '../src/project-memory.ts'
import { captureSession } from './session-support.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { delegationDirectory } from '../src/delegation-state.ts'
import { digest, inventory, sensitive } from '../src/paths.ts'
import { textResult } from '../src/file-tools.ts'

const claim: MemoryFact = {
  key: 'launch-access',
  revision: 0,
  kind: 'observation',
  text: 'Access arrives Monday',
  source: 'session:first#1',
  quote: 'Monday',
  paths: [],
}

test('concurrent corrections preserve history and roll back stale batches', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-memory-db-'))
  const first = new MemoryStore(join(dir, 'memory.sqlite'))
  const second = new MemoryStore(join(dir, 'memory.sqlite'))
  t.after(async () => {
    first.close()
    second.close()
    await rm(dir, { recursive: true, force: true })
  })
  first.update([claim])
  assert.deepEqual(second.update([claim]), [{ key: claim.key, revision: 1 }])
  second.update([{ ...claim, key: 'demo', text: 'Friday demo' }])
  first.update([{ ...claim, revision: 1, kind: 'resolved', text: 'Credentials received' }])
  assert.throws(
    () =>
      second.update([
        { ...claim, key: 'rolled-back' },
        { ...claim, revision: 1, text: 'Outdated plan' },
      ]),
    /concurrently/,
  )
  assert.deepEqual(
    second.facts().map((f) => f.key),
    ['demo', 'launch-access'],
  )
  assert.deepEqual(
    first.history(claim.key).map((v) => v.revision),
    [2, 1],
  )
})

test('bootstrap is shared across worktrees and scoped to the local clone', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-roots-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'primary')
  const linked = join(base, 'linked')
  await mkdir(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-qb', 'main')
  await writeFile(join(root, 'README.md'), 'A relay.')
  await symlink(join(base, 'secret'), join(root, 'design'))
  git('add', '.')
  git('-c', 'user.name=Pi', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'seed')
  git('worktree', 'add', '-qb', 'second', linked)
  const a = await memoryRepository(root)
  const b = await memoryRepository(linked)
  assert.ok(a && b)
  assert.equal(a.identity, b.identity)
  assert.notEqual(a.root, b.root)
  const first = repositoryStore(a)
  const second = repositoryStore(b)
  t.after(() => {
    first.close()
    second.close()
  })
  first.seed(await discoverSources(root))
  second.seed(['incorrect-overwrite.md'])
  assert.deepEqual(second.sources(), ['README.md'])
  git('clone', '-q', root, join(base, 'clone'))
  const clone = await memoryRepository(join(base, 'clone'))
  assert.ok(clone && clone.identity !== a.identity)
  const separate = repositoryStore(clone)
  t.after(() => separate.close())
  assert.equal(separate.sources(), undefined)
})

test('Pi checks evidence and reconciles changed priorities before dispatch', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-turn-')))
  const root = join(base, 'repo')
  await mkdir(root)
  execFileSync('git', ['init', '-q', root])
  await writeFile(join(root, 'README.md'), '# Relay Desk\nOrders are synchronized.')
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = base
  t.after(async () => {
    if (previous) {
      process.env.PI_HARNESS_AGENT_DIR = previous
    } else {
      delete process.env.PI_HARNESS_AGENT_DIR
    }

    await rm(base, { recursive: true, force: true })
  })
  const repo = await memoryRepository(root)
  assert.ok(repo)
  const concurrent = repositoryStore(repo)
  t.after(() => concurrent.close())
  let step = 0
  let dispatched = 0
  const { session } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerProjectMemory(pi)
        pi.registerTool({
          name: 'delegate_task',
          label: 'Dispatch',
          description: 'Dispatch fixture',
          parameters: Type.Object({}),
          async execute() {
            dispatched++
            return textResult('dispatched')
          },
        })
      },
    ],
    async (ctx) => {
      const context = JSON.stringify(ctx.messages)
      step++

      if (step === 1) {
        assert.match(context, /Relay Desk/)
        return [
          {
            type: 'toolCall',
            id: 'incorrect',
            name: 'update_project_memory',
            arguments: {
              facts: [{ ...claim, source: 'user', quote: 'invented by the assistant' }],
            },
          },
        ]
      }

      if (step === 2) {
        assert.match(context, /Quote must occur/)
        concurrent.update([
          { ...claim, key: 'priority', text: 'Resolve the customer dependency first' },
        ])
        return [{ type: 'toolCall', id: 'dispatch', name: 'delegate_task', arguments: {} }]
      }

      if (step === 3) {
        assert.match(context, /Reconcile before dispatch/)
        assert.match(context, /Resolve the customer dependency first/)
        assert.equal(dispatched, 0)
      }

      return [{ type: 'text', text: 'Revised plan.' }]
    },
  )

  try {
    await session.prompt('Which work should we schedule next?')
    await session.waitForIdle()
    assert.equal(step, 3)
    assert.deepEqual(
      concurrent.facts().map((f) => f.key),
      ['priority'],
    )
  } finally {
    await session.dispose()
  }
})

test('fresh chat resolves saved paths without repeating discovery', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-recall-')))
  const root = join(base, 'main')
  const other = join(base, 'other')
  await mkdir(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-qb', 'main')
  await writeFile(join(root, 'README.md'), 'Parcel Relay synchronizes orders.')
  await writeFile(join(root, 'main.ts'), 'export const relay = true')
  git('add', '.')
  git('-c', 'user.name=Pi', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'fixture')
  git('worktree', 'add', '-qb', 'demo', other)
  await rm(join(other, 'main.ts'))
  await writeFile(join(other, 'design.md'), 'SECOND_SCAN_SENTINEL')
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = base
  t.after(async () => {
    if (previous) {
      process.env.PI_HARNESS_AGENT_DIR = previous
    } else {
      delete process.env.PI_HARNESS_AGENT_DIR
    }

    await rm(base, { recursive: true, force: true })
  })
  let first = true
  const a = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerProjectMemory(pi)
      },
    ],
    async (ctx) => {
      if (first) {
        first = false
        assert.match(JSON.stringify(ctx.messages), /Parcel Relay/)
        return [
          {
            type: 'toolCall',
            id: 'product',
            name: 'update_project_memory',
            arguments: {
              facts: [
                {
                  key: 'product',
                  revision: 0,
                  kind: 'observation',
                  text: 'Parcel Relay syncs orders',
                  share: true,
                  quote: 'Parcel Relay synchronizes orders.',
                  source: 'README.md',
                  paths: ['main.ts'],
                },
              ],
            },
          },
        ]
      }

      return [{ type: 'text', text: 'Parcel Relay.' }]
    },
  )

  try {
    await a.session.prompt('What is this project?')
    await a.session.waitForIdle()
  } finally {
    await a.session.dispose()
  }

  const b = await captureSession(
    other,
    base,
    [
      (pi) => {
        registerProjectMemory(pi)
      },
    ],
    async (ctx) => {
      const message = ctx.messages.find((m) =>
        JSON.stringify(m.content).includes('Repository project brief'),
      )
      assert.ok(message)
      const data = JSON.stringify(message.content)
      assert.match(data, /Parcel Relay syncs orders/)
      assert.doesNotMatch(data, /SECOND_SCAN_SENTINEL|bootstrap/)
      assert.match(data, /main.ts.{0,8}available.{0,5}false/)
      return [{ type: 'text', text: 'The integration file is missing here.' }]
    },
  )

  try {
    await b.session.prompt('What next?')
    await b.session.waitForIdle()
    assert.equal(b.session.messages.at(-1)?.role, 'assistant')
    const reply = b.session.messages.findLast((m) => m.role === 'assistant')
    assert.equal(reply?.stopReason, 'stop', reply?.errorMessage)
  } finally {
    await b.session.dispose()
  }

  const markdown = await readFile(join(root, briefName), 'utf8')
  assert.match(markdown, /Parcel Relay syncs orders/)
  assert.doesNotMatch(markdown, /Parcel Relay synchronizes orders|session:|file:/)
  assert.equal(
    git('status', '--porcelain', '--untracked-files=all').toString().trim(),
    '?? ' + briefName,
  )
  await writeFile(join(root, '.gitignore'), '.pi/\n')
  git('add', '.gitignore')
  git('-c', 'user.name=Pi', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'Ignore Pi')
  git('add', '-f', '--', briefName)
  assert.equal(git('diff', '--cached', '--name-only').toString().trim(), briefName)
  git('-c', 'user.name=Pi', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'Project brief')
  const clone = join(base, 'fresh-clone')
  git('clone', '-q', root, clone)
  const fresh = await captureSession(
    clone,
    base,
    [(pi) => registerProjectMemory(pi)],
    async (ctx) => {
      const messages = JSON.stringify(ctx.messages)
      assert.match(messages, /projectBrief.*Parcel Relay syncs orders/)
      assert.doesNotMatch(messages, /file:README/)
      return [{ type: 'text', text: 'Recovered the project goal from the brief.' }]
    },
  )

  try {
    await fresh.session.prompt('What next?')
    await fresh.session.waitForIdle()
    const response = fresh.session.messages.findLast((m) => m.role === 'assistant')
    assert.equal(response?.stopReason, 'stop', response?.errorMessage)
  } finally {
    await fresh.session.dispose()
  }
})

test('delivered worker evidence keeps its branch and commit', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-result-')))
  const root = join(base, 'root')
  await mkdir(root)
  execFileSync('git', ['init', '-q', root])
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = base
  t.after(async () => {
    if (previous) {
      process.env.PI_HARNESS_AGENT_DIR = previous
    } else {
      delete process.env.PI_HARNESS_AGENT_DIR
    }

    await rm(base, { recursive: true, force: true })
  })
  const store = new StateStore(root)
  let id = ''
  let step = 0
  const { session } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerDelegation(pi, async (request) => {
          id = request.id
          await atomicJson(join(delegationDirectory(store, id), 'status.json'), {
            id,
            status: 'needs_attention',
            updatedAt: new Date().toISOString(),
            branch: 'demo',
            commit: 'f'.repeat(40),
            summary: 'Provider suspended the sandbox.',
          })
        })
        registerProjectMemory(pi)
      },
    ],
    async (ctx) => {
      step++

      if (step === 1) {
        return [
          {
            type: 'toolCall',
            id: 'inspect',
            name: 'delegate_task',
            arguments: {
              kind: 'research',
              task: 'Inspect sandbox availability',
              context: '',
              writePaths: [],
            },
          },
        ]
      }

      if (step === 2) {
        assert.match(JSON.stringify(ctx.messages), /Background task outcome/)
        return [
          {
            type: 'toolCall',
            id: 'record-change',
            name: 'update_project_memory',
            arguments: {
              facts: [
                {
                  key: 'sandbox-option',
                  share: true,
                  revision: 0,
                  kind: 'inference',
                  text: 'The sandbox fallback is unavailable pending provider recovery.',
                  source: 'task:' + id,
                  quote: 'Provider suspended the sandbox.',
                },
              ],
            },
          },
        ]
      }

      return [{ type: 'text', text: 'The fallback needs replanning.' }]
    },
  )

  try {
    await session.prompt('Have a worker check the sandbox fallback.')
    await session.waitForIdle()
    const repo = await memoryRepository(root)
    assert.ok(repo)
    const db = repositoryStore(repo)

    try {
      const [fact] = db.facts()
      assert.ok(fact)
      assert.equal(fact.kind, 'inference')
      assert.match(fact.source, /status.json @ demo @ f{40}/)
      assert.ok(fact.source.includes(id))
      assert.equal(readBrief(repo.home), '')
    } finally {
      db.close()
    }
  } finally {
    await session.dispose()
  }
})

test('replays pending edits and preserves human revisions', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-brief-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', base])
  const repo = await memoryRepository(base)
  assert.ok(repo)
  const db = repositoryStore(repo)
  t.after(() => db.close())
  const first = portableLine('', claim, true, false)
  assert.ok(first)
  assert.equal(portableLine('', { ...claim, kind: 'tentative' }, true, false), undefined)
  db.update([claim], [first])
  const other = repositoryStore(repo)
  t.after(() => other.close())
  const brief = join(base, briefName)
  await writeFile(brief, '# Demo plan\n\nKeep this handwritten paragraph.\n')
  assert.deepEqual(syncBrief(other, base), [])
  const published = readBrief(base)
  assert.match(published, /handwritten paragraph/)
  assert.match(published, /Access arrives Monday/)
  const correction = { ...claim, revision: 1, text: 'Credentials arrived early', kind: 'resolved' }
  const next = portableLine(published, correction, undefined, false)
  assert.ok(next)
  db.update([correction], [next])
  const edited = published.replace('Access arrives Monday', 'Access date unconfirmed')
  await writeFile(brief, edited)
  assert.deepEqual(syncBrief(other, base), [claim.key])
  assert.equal(readBrief(base), edited)
  const retry = portableLine(edited, correction, true, false)
  assert.ok(retry)
  db.update([correction], [retry])
  syncBrief(db, base)
  assert.match(readBrief(base), /Credentials arrived early/)
  assert.doesNotMatch(readBrief(base), /Access date unconfirmed|session:first/)
  assert.ok(!(await inventory(base)).has(briefName))
  assert.ok(sensitive('.pi/local-memory/memory.sqlite-wal'))
  assert.ok(![...(await inventory(base)).keys()].some((path) => path.includes('local-memory')))
  await rm(brief)
  await symlink(join(base, 'README.md'), brief)
  assert.throws(() => readBrief(base))
})

test('upgrade imports legacy history and reconciles late writes from older hosts', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-migrate-')))
  const root = join(base, 'root')
  execFileSync('git', ['init', '-q', root])
  const repo = await memoryRepository(root)
  assert.ok(repo)
  const legacy = join(base, 'project-memory', digest(repo.identity))
  await mkdir(legacy, { recursive: true })
  const old = new MemoryStore(join(legacy, 'memory.sqlite'))
  old.seed(['README.md'])
  old.host(root)
  old.update([claim])
  old.update([{ ...claim, revision: 1, kind: 'resolved' }])
  const prior = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = base
  t.after(async () => {
    old.close()

    if (prior) {
      process.env.PI_HARNESS_AGENT_DIR = prior
    } else {
      delete process.env.PI_HARNESS_AGENT_DIR
    }

    await rm(base, { recursive: true, force: true })
  })
  const db = repositoryStore(repo)

  try {
    assert.deepEqual(
      db.history(claim.key).map((row) => row.revision),
      [2, 1],
    )
    assert.deepEqual(db.sources(), ['README.md'])
    assert.deepEqual(db.hosts(), [root])
    assert.equal(readBrief(root), '')
    db.update([{ ...claim, revision: 2, text: 'Current decision' }])
  } finally {
    db.close()
  }

  old.update([{ ...claim, key: 'previous-version-only' }])
  old.update([{ ...claim, revision: 2, text: 'Competing legacy decision' }])
  old.update([{ ...claim, revision: 3, text: 'Follow-up to legacy decision' }])
  const reopened = repositoryStore(repo)

  try {
    assert.deepEqual(
      reopened.facts().map((f) => f.key),
      [claim.key, 'previous-version-only'],
    )
    assert.equal(reopened.facts()[0]?.text, 'Current decision')
    const conflicts = reopened.history(claim.key).filter((row) => row.origin === 'legacy-conflict')
    assert.equal(conflicts.length, 2)
  } finally {
    reopened.close()
  }
})

test('host can checkpoint an earlier verified decision', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-memory-checkpoint-')))
  execFileSync('git', ['init', '-q', root])
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = await memoryRepository(root)
  assert.ok(repo)
  const db = repositoryStore(repo)
  const fact = { ...claim, kind: 'decision' }
  db.update([fact])
  t.after(() => db.close())
  let step = 0
  const host = await captureSession(
    root,
    root,
    [(pi) => registerProjectMemory(pi)],
    async (ctx) => {
      step++

      if (step === 2) {
        assert.match(JSON.stringify(ctx.messages), /Use the exact current fact/)
        assert.equal(readBrief(root), '')
      }

      if (step <= 2) {
        return [
          {
            type: 'toolCall',
            id: 'checkpoint-' + step,
            name: 'update_project_memory',
            arguments: {
              facts: [
                {
                  ...fact,
                  source: 'recorded',
                  revision: 1,
                  share: true,
                  text: step === 1 ? 'An unsupported revision' : fact.text,
                },
              ],
            },
          },
        ]
      }

      return [{ type: 'text', text: 'Updated the brief.' }]
    },
  )

  try {
    await host.session.prompt('Checkpoint the agreed project decision.')
    await host.session.waitForIdle()
    assert.equal(step, 3)
    assert.match(readBrief(root), /Access arrives Monday/)
    assert.equal(db.history(claim.key).length, 1)
  } finally {
    await host.session.dispose()
  }
})
