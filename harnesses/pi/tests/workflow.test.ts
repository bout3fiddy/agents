import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runWorkflow } from '../src/workflow.ts'
import { fixture, evidence, design } from './support.ts'
import { hasSkippedTests, loadProject, verifyProject } from '../src/project.ts'
import { inventory } from '../src/paths.ts'

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
  assert.equal((await scoped(['external.md']))[0]!.status, 'failed')
  await writeFile(reference, 'b' + original)
  assert.equal((await scoped())[0]!.status, 'failed')
  await writeFile(reference, original)
  await writeFile(join(item.root, 'added.md'), original)
  assert.equal((await scoped())[0]!.status, 'failed')
  await rm(join(item.root, 'added.md'))
  await writeFile(join(item.root, 'src/value.js'), '// ' + original)
  assert.equal((await scoped())[0]!.status, 'failed')
  await writeFile(join(item.root, 'src/value.js'), 'export const value = 0\n')
  const ordinary = join(item.root, 'ordinary.md')
  await writeFile(ordinary, original)
  const ordinaryBase = { files: await inventory(item.root), writePaths: ['src/**'] }
  const ordinaryResult = await verifyProject(item.root, project, false, undefined, ordinaryBase)
  assert.equal(ordinaryResult[0]!.status, 'failed')
  assert.match(ordinaryResult[0]!.result.output, /ordinary\.md:1: line exceeds/)
  await rm(ordinary)
  const script = join(item.root, 'external.js')
  await writeFile(script, '// ' + original)
  const codeBase = { files: await inventory(item.root), writePaths: ['src/**'] }
  const codeResult = await verifyProject(item.root, project, false, undefined, codeBase)
  assert.equal(codeResult[0]!.status, 'failed')
  assert.match(codeResult[0]!.result.output, /external\.js:1: line exceeds/)
  await rm(script)
  await writeFile(join(item.root, '.prettierignore'), '*.md\n')
  assert.equal((await scoped())[0]!.status, 'failed')
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

test('review repair, conditional database review and benchmarks gate integration', async () => {
  const item = await fixture({ database: true, performance: true })
  const called: string[] = []
  let reviews = 0

  try {
    const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
      called.push(request.role)

      if (request.role === 'implementer') {
        await writeFile(
          join(request.workspace, 'src/value.js'),
          `export const value = ${reviews + 1}\n`,
        )
      }

      if (request.role === 'reviewer' && reviews++ === 0) {
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

      return evidence(request)
    })
    assert.equal(result.status, 'complete', result.error)
    assert.equal(result.round, 2)
    assert.equal(
      await readFile(join(item.root, 'src/value.js'), 'utf8'),
      'export const value = 2\n',
    )
    assert.deepEqual(
      new Set(called),
      new Set(['implementer', 'reviewer', 'database-reviewer', 'performance']),
    )
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
    assert.match(result.error!, /same failure persisted without candidate changes/)
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
        request.role === 'reviewer' && attempts < 5
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

      if (request.role === 'reviewer') {
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

test(
  'stale review receipts fail closed; no database role for an unrelated' + ' change',
  async () => {
    const item = await fixture()
    const roles: string[] = []

    try {
      const result = await runWorkflow(item.store, 'fixture/model', undefined, async (request) => {
        roles.push(request.role)
        const output = await evidence(request)

        if (request.role === 'reviewer') {
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
  },
)

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

test('interrupted review resumes retained code and rejects a changed baseline', async () => {
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

        if (request.role === 'reviewer') {
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
    assert.deepEqual(roles, ['reviewer', 'database-reviewer'])
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
