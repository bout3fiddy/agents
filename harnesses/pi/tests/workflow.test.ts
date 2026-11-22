import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runWorkflow } from '../src/workflow.ts'
import { fixture, evidence, design } from './support.ts'
import { hasSkippedTests, loadProject, verifyProject } from '../src/project.ts'
import { inventory, snapshotHash } from '../src/paths.ts'

test('Git ignores protect nested roots and prevent ignored additions', async () => {
  const item = await fixture()

  try {
    execFileSync('git', ['init', '-q', '--template=', item.root])
    await writeFile(join(item.root, '.gitignore'), '*.log\n')
    await writeFile(join(item.root, 'src/debug.log'), 'PRIVATE_IGNORED_MARKER')
    const nested = await inventory(join(item.root, 'src'))
    assert.deepEqual([...nested.keys()], ['value.js'])
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      if (request.role === 'implementer') {
        await writeFile(join(request.workspace, 'src/new.log'), 'generated')
      }

      return evidence(request)
    })
    assert.equal(result.status, 'needs_attention')
    assert.match(result.error!, /ignored by project policy/)
    await assert.rejects(readFile(join(item.root, 'src/new.log')), { code: 'ENOENT' })
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('failed verifications stop at the repair budget while the candidate changes', async () => {
  const item = await fixture()

  try {
    const adapterPath = join(item.root, '.pi/harness.json')
    const adapter = JSON.parse(await readFile(adapterPath, 'utf8'))
    adapter.checks[0].argv = ['node', '-e', 'process.exit(1)']
    await writeFile(adapterPath, JSON.stringify(adapter, null, 2) + '\n')
    let implementations = 0
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      if (request.role === 'implementer') {
        implementations++
        const source = `export const value = ${implementations}\n`
        await writeFile(join(request.workspace, 'src/value.js'), source)
      }

      return evidence(request)
    })
    assert.equal(result.status, 'needs_attention')
    assert.match(result.error!, /Workflow repair stopped after 6 failed rounds/)
    assert.equal(implementations, 6)
    assert.equal(result.round, 6)
    assert.equal(
      await readFile(join(item.root, 'src/value.js'), 'utf8'),
      'export const value = 0\n',
    )
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('skip detection covers test runners and accepts explicit zero counts', () => {
  for (const output of [
    '# skipped 1',
    '2 pending',
    '--- SKIP: TestX (0.00s)',
    'test result: ok. 3 passed; 0 failed; 2 ignored',
    'SKIPPED [1] test_x.py:3: reason',
    'OK (skipped=1)',
    'ok 1 - pending # TODO',
  ]) {
    assert.ok(hasSkippedTests(output), output)
  }

  for (const output of ['# skipped 0', 'Tests: 0 tests skipped', 'OK (skipped=0)']) {
    assert.equal(hasSkippedTests(output), false, output)
  }
})

test('scoped lint distinguishes preserved reference prose from authored changes', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const reference = join(item.root, 'external.md')
  const original = 'a'.repeat(101) + '\n'
  await writeFile(reference, original)
  await writeFile(join(item.root, '.prettierignore'), '/external.md\n/added.md\n*.js\n')
  const files = await inventory(item.root)
  const project = await loadProject(item.root)
  project.checks[0]!.argv = [
    'node',
    '-e',
    'if (require("fs").readFileSync("external.md", "utf8").length !== 102) throw 1',
  ]
  const scoped = (writePaths = ['src/**']) =>
    verifyProject(item.root, project, false, undefined, { files, writePaths })
  const passed = await scoped()
  assert.deepEqual(
    passed.map((entry) => entry.status),
    ['passed', 'passed'],
  )
  assert.match(passed[0]!.result.output, /external\.md/)
  assert.equal((await verifyProject(item.root, project, false))[0]!.status, 'failed')

  // In scope but byte-identical: the base already had this finding, so it is reported only.
  const unchanged = (await scoped(['external.md']))[0]!
  assert.equal(unchanged.status, 'passed')
  assert.deepEqual(unchanged.inheritedLintPaths, ['external.md'])
  await writeFile(reference, 'b' + original)
  assert.equal((await scoped())[0]!.status, 'failed')
  await writeFile(reference, original)
  await writeFile(join(item.root, 'added.md'), original)
  assert.equal((await scoped())[0]!.status, 'failed')
  await rm(join(item.root, 'added.md'))
  await writeFile(join(item.root, 'src/value.js'), '// ' + original)
  const authored = (await scoped())[0]!
  assert.equal(authored.status, 'failed')
  assert.match(authored.scopedLintOutput!, /src\/value\.js:1: line exceeds/)
  await writeFile(join(item.root, 'src/value.js'), 'export const value = 0\n')
  const ordinary = join(item.root, 'ordinary.md')
  await writeFile(ordinary, original)
  const ordinaryBase = { files: await inventory(item.root), writePaths: ['src/**'] }
  const ordinaryResult = await verifyProject(item.root, project, false, undefined, ordinaryBase)
  assert.equal(ordinaryResult[0]!.status, 'passed')
  assert.match(ordinaryResult[0]!.result.output, /ordinary\.md:1: line exceeds/)
  assert.deepEqual(ordinaryResult[0]!.inheritedLintPaths, ['ordinary.md'])
  await rm(ordinary)
  const script = join(item.root, 'external.js')
  await writeFile(script, '// ' + original)
  const codeBase = { files: await inventory(item.root), writePaths: ['src/**'] }
  const codeResult = await verifyProject(item.root, project, false, undefined, codeBase)
  assert.equal(codeResult[0]!.status, 'passed')
  assert.deepEqual(codeResult[0]!.inheritedLintPaths, ['external.js'])
  await writeFile(script, '// ' + original + '// ' + 'c'.repeat(101) + '\n')
  const added = (await verifyProject(item.root, project, false, undefined, codeBase))[0]!
  assert.equal(added.status, 'failed')
  assert.match(added.scopedLintOutput!, /external\.js:2: line exceeds/)
  assert.doesNotMatch(added.scopedLintOutput!, /external\.js:1:/)
  await rm(script)
})

test('truncated required-check output cannot hide a skipped test', async () => {
  const item = await fixture()

  try {
    const project = await loadProject(item.root)
    project.checks[0]!.argv = [
      'node',
      '-e',
      'console.log("x".repeat(72000)); console.log("# skipped 1")',
    ]
    const receipts = await verifyProject(item.root, project, false)
    const receipt = receipts.find((entry) => entry.check === 'contract')!
    assert.equal(receipt.result.exitCode, 0)
    assert.equal(receipt.result.truncated, true)
    assert.equal(receipt.status, 'failed')
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('selected performance work runs with required checks', async () => {
  const item = await fixture({
    database: true,
    performance: true,
    performanceReview: true,
  })
  const called: string[] = []
  let reviews = 0

  try {
    const result = await runWorkflow(
      item.store,
      'fixture/model',
      undefined,
      async (request) => {
        called.push(request.role)
        const expected = new Map([
          ['implementer', 'high'],
          ['performance', 'high'],
        ])
        assert.equal(request.thinking, expected.get(request.role))

        if (request.role === 'implementer') {
          await writeFile(
            join(request.workspace, 'src/value.js'),
            `export const value = ${reviews + 1}\n`,
          )
        }

        if (request.role === 'performance') {
          assert.equal(request.reviewOf, 'fixture-author')
        }

        if (request.role === 'performance' && reviews++ === 0) {
          return evidence(request, {
            verdict: 'changes',
            findings: [
              {
                severity: 'required',
                location: 'src/value.js:1',
                problem: 'Value must be 2',
                evidence: 'Observed 1',
              },
            ],
          })
        }

        return {
          ...(await evidence(request)),
          liveWorkerId: request.role === 'implementer' ? 'fixture-author' : 'fixture-worker',
        }
      },
      { implementer: 'high', performance: 'high' },
    )
    assert.equal(result.status, 'complete', result.error)
    assert.equal(result.round, 2)
    assert.equal(
      await readFile(join(item.root, 'src/value.js'), 'utf8'),
      'export const value = 2\n',
    )
    assert.deepEqual(new Set(called), new Set(['implementer', 'performance']))
    assert.ok(result.receipts.every((receipt) => receipt.status === 'passed'))
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('required skips never become completion', async () => {
  const item = await fixture()

  try {
    const adapterPath = join(item.root, '.pi/harness.json')
    const adapter = JSON.parse(await readFile(adapterPath, 'utf8'))
    adapter.checks[0].argv = ['node', '-e', 'console.log("# skipped 1")']
    await writeFile(adapterPath, JSON.stringify(adapter, null, 2) + '\n')
    const result = await runWorkflow(item.store, 'fixture/model', undefined, (request) =>
      evidence(request),
    )
    assert.equal(result.status, 'needs_attention')
    assert.equal(result.round, 2)
    assert.match(result.error!, /Workflow repair made no progress on the same candidate/)
    assert.ok(result.receipts.some((receipt) => receipt.status === 'skipped'))
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('productive repair continues beyond three rounds', async () => {
  const item = await fixture()
  let attempts = 0

  try {
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      if (request.role === 'implementer') {
        await writeFile(
          join(request.workspace, 'src/value.js'),
          `export const value = ${++attempts}\n`,
        )
      }

      return evidence(
        request,
        attempts < 5
          ? {
              verdict: 'changes',
              summary: 'Another productive repair is required',
              findings: [
                {
                  severity: 'required',
                  location: 'src/value.js:1',
                  problem: 'Fixture needs five',
                  evidence: `Observed ${attempts}`,
                },
              ],
            }
          : {},
      )
    })
    assert.equal(result.status, 'complete', result.error)
    assert.equal(result.round, 5)
    assert.equal(
      await readFile(join(item.root, 'src/value.js'), 'utf8'),
      'export const value = 5\n',
    )
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('missing required acceptance checks fail before any model dispatch', async () => {
  const item = await fixture()
  let dispatched = false

  try {
    await writeFile(join(item.root, '.pi/harness.json'), '{"checks": []}\n')
    await assert.rejects(
      runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
        dispatched = true
        return evidence(request)
      }),
      /Configure required test checks/,
    )
    assert.equal(dispatched, false)
    assert.equal(await item.store.task(), undefined)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('concurrent user edits are preserved and invalidate the candidate', async () => {
  const item = await fixture()

  try {
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      if (request.role === 'implementer') {
        await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 2\n')
      }

      if (request.role === 'implementer') {
        await writeFile(join(item.root, 'src/value.js'), 'export const value = 99\n')
      }

      return evidence(request)
    })
    assert.equal(result.status, 'needs_attention')
    assert.match(result.error!, /Project changed/)
    assert.match(await readFile(join(item.root, 'src/value.js'), 'utf8'), /99/)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('stale implementation receipts prevent completion', async () => {
  const item = await fixture()
  const roles: string[] = []

  try {
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      roles.push(request.role)
      const output = await evidence(request)

      if (request.role === 'implementer') {
        output.snapshot = 'stale'
      }

      return output
    })
    assert.equal(result.status, 'needs_attention')
    assert.match(result.error!, /Stale/)
    assert.ok(!roles.includes('database-reviewer'))
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('cancellation retains work and releases the project lock', async () => {
  const item = await fixture()
  const controller = new AbortController()

  try {
    const result = await runWorkflow(
      item.store,
      'fixture/model',
      controller.signal,
      async (request) => {
        controller.abort()
        return evidence(request)
      },
    )
    assert.equal(result.status, 'interrupted')
    const release = await item.store.lock()
    await release()
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('interrupted work resumes only on the original baseline', async () => {
  const item = await fixture({ database: true })
  const controller = new AbortController()

  try {
    const first = await runWorkflow(
      item.store,
      'fixture/model',
      controller.signal,
      async (request) => {
        if (request.role === 'implementer') {
          await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 2\n')
        }

        if (request.role === 'implementer') {
          controller.abort()
        }

        return evidence(request)
      },
    )
    assert.equal(first.status, 'interrupted')
    await writeFile(join(item.root, 'src/value.js'), 'export const value = 99\n')
    await assert.rejects(runWorkflow(item.store, 'fixture/model'), /baseline changed/)
    assert.match(await readFile(join(item.root, 'src/value.js'), 'utf8'), /99/)
    await writeFile(join(item.root, 'src/value.js'), 'export const value = 0\n')
    const roles: string[] = []
    const resumed = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      roles.push(request.role)
      assert.match(await readFile(join(request.workspace, 'src/value.js'), 'utf8'), /2/)
      return evidence(request)
    })
    assert.equal(resumed.status, 'complete', resumed.error)
    assert.equal(resumed.resumedFrom, first.id)
    assert.deepEqual(roles, ['implementer'])
    assert.match(await readFile(join(item.root, 'src/value.js'), 'utf8'), /2/)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('accepting the same design again starts from the new project baseline', async () => {
  const item = await fixture()
  const controller = new AbortController()

  try {
    const first = await runWorkflow(
      item.store,
      'fixture/model',
      controller.signal,
      async (request) => {
        controller.abort()
        return evidence(request)
      },
    )
    assert.equal(first.status, 'interrupted')
    await writeFile(join(item.root, 'src/value.js'), 'export const value = 7\n')
    await item.store.draft(design)
    await item.store.accept()
    const next = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      assert.match(await readFile(join(request.workspace, 'src/value.js'), 'utf8'), /7/)
      return evidence(request)
    })
    assert.equal(next.status, 'complete', next.error)
    assert.equal(next.resumedFrom, undefined)
    assert.equal(next.designVersion, 2)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('routine DB and benchmark work passes with executable evidence alone', async (t) => {
  const item = await fixture({ database: true, performance: true })
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const result = await runWorkflow(item.store, 'fixture/model', undefined, (child) =>
    evidence(child),
  )
  assert.equal(result.status, 'complete', result.error)
  assert.deepEqual(
    result.evidence.map((worker) => worker.role),
    ['implementer'],
  )
  assert.ok(
    ['contract', 'latency', 'recovery'].every((id) =>
      result.receipts.some((check) => check.check === id && check.status === 'passed'),
    ),
  )
})

test('retired database findings resume with a writer and recovery checks', async (t) => {
  const { base, store } = await fixture({ database: true })
  t.after(() => rm(base, { recursive: true, force: true }))
  const controller = new AbortController()
  const paused = await runWorkflow(store, 'fixture/model', controller.signal, async (request) => {
    controller.abort()
    return evidence(request)
  })
  const snapshot = snapshotHash(await inventory(paused.candidate!))
  paused.phase = 'review'
  paused.snapshot = snapshot
  paused.reviewRound = { snapshot, start: 0, database: true }
  paused.evidence.push({
    role: 'database-reviewer',
    model: 'historical',
    snapshot,
    commands: [],
    turns: 1,
    result: {
      verdict: 'changes',
      summary: 'Recovery misses the last acknowledged value',
      findings: [
        {
          severity: 'required',
          location: 'src/value.js',
          problem: 'Lost value',
          evidence: 'Recovery returned zero',
        },
      ],
      databaseImpact: true,
      evidence: [],
    },
  })
  const previous = paused.evidence.at(-1)!
  paused.evidence.push({
    ...previous,
    role: 'reviewer',
    result: { ...previous.result, summary: 'Reject duplicate acknowledgements' },
  })
  await store.saveTask(paused)
  const calls: string[] = []
  const resumed = await runWorkflow(store, 'fixture/model', undefined, async (request) => {
    calls.push(request.role)
    assert.match(request.task, /Recovery misses the last acknowledged value/)
    assert.match(request.task, /Reject duplicate acknowledgements/)
    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    return evidence(request)
  })
  assert.equal(resumed.status, 'complete', resumed.error)
  assert.deepEqual(calls, ['implementer'])
  assert.ok(resumed.receipts.some((r) => r.check === 'recovery' && r.status === 'passed'))
})

test('impact reported by implementation runs recovery on the candidate', async (t) => {
  const item = await fixture({ database: true })
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await item.store.pin({ ...design, database: false })
  const result = await runWorkflow(item.store, 'fixture/model', undefined, (request) =>
    evidence(request, { databaseImpact: true }),
  )
  assert.equal(result.status, 'complete', result.error)
  assert.ok(result.receipts.some((r) => r.check === 'recovery' && r.status === 'passed'))
})

test('a blocked implementation persists the current host handoff', async (t) => {
  const { base, store } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const hostActions = [{ capability: 'dependencies' as const, reason: 'Prepare the pinned SDK' }]
  const task = await runWorkflow(store, 'fixture/model', undefined, (request) =>
    evidence(request, { verdict: 'blocked', hostActions }),
  )
  assert.equal(task.status, 'needs_attention')
  assert.deepEqual((await store.task())?.hostActions, hostActions)
})

test('inherited lint is reported without blocking the candidate', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'guide.md'), 'x'.repeat(101) + '\n')
  const calls: string[] = []
  const task = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
    calls.push(request.role)
    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 4\n')
    return evidence(request)
  })
  assert.equal(task.status, 'complete', task.error)
  assert.deepEqual(calls, ['implementer'])
  assert.equal(task.receipts[0]?.check, 'harness-lint')
  assert.equal(task.receipts[0]?.status, 'passed')
  assert.deepEqual(task.receipts[0]?.inheritedLintPaths, ['guide.md'])
  assert.match(await readFile(join(item.root, 'src/value.js'), 'utf8'), /value = 4/)
})

test('mixed lint findings keep repair with the writer', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'guide.md'), 'x'.repeat(101) + '\n')
  let calls = 0
  const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
    calls++
    assert.ok(calls <= 2)

    if (calls === 2) {
      assert.match(request.task, /src\/value\.js:1: line exceeds/)
      assert.doesNotMatch(request.task, /guide\.md:1/)
    }

    const value = calls === 1 ? '// ' + 'x'.repeat(101) : 'export const value = 3'
    await writeFile(join(request.workspace, 'src/value.js'), value + '\n')
    return evidence(request)
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.receipts[0]?.inheritedLintPaths, ['guide.md'])
  assert.equal(result.status, 'complete', result.error)
})
