import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkerRequest } from '../src/contracts.ts'
import { createWorkerTools } from '../src/worker-tools.ts'
import { loadRole } from '../src/roles.ts'
import { loadProject } from '../src/project.ts'
import { verifyLoop } from '../src/verification-loop.ts'
import { fixture } from './support.ts'

test('implementer replays the first divergent seed on frozen copies', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const original = join(item.base, 'original')
  await mkdir(original)
  const installed = join(item.base, 'installed')
  await mkdir(join(installed, 'fixture-dep'), { recursive: true })
  await writeFile(join(installed, 'fixture-dep/index.js'), 'exports.value = 1')
  await symlink(installed, join(item.root, 'node_modules'))
  const reference =
    "require('fs').writeFileSync('dirty', String(require('fixture-dep').value)); " +
    'console.log(process.argv[2])'
  const candidate = reference.replace(
    'log(process.argv[2])',
    'log(+process.argv[2] === 4 ? 0 : process.argv[2])',
  )
  await writeFile(join(original, 'oracle.cjs'), reference)
  await writeFile(join(item.root, 'oracle.cjs'), candidate)
  const request: WorkerRequest = {
    role: 'implementer',
    model: 'fixture',
    task: 'Compare candidates',
    workspace: item.root,
    originals: original,
    project: await loadProject(item.root),
    checkpoint: (await item.store.checkpoint())!,
    outputPath: join(item.base, 'attempt'),
    baseline: {},
  }
  const role = await loadRole('implementer')
  const tool = createWorkerTools(request, role).tools.find(
    (itemTool) => itemTool.name === 'verify_loop',
  )!
  const invoke = async (input: object) => {
    const result = await tool.execute('test', input, undefined, undefined, {} as never)
    const content = result.content[0]!
    assert.equal(content.type, 'text')
    return JSON.parse(content.text)
  }
  const input = {
    mode: 'differential',
    argv: ['node', 'oracle.cjs', '{seed}'],
    firstSeed: 2,
    count: 5,
  }
  const failed = await invoke(input)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.completed, 2)
  assert.equal(failed.seed, 4)
  assert.notEqual(failed.originalSnapshot, failed.snapshot)
  assert.equal((await invoke(failed.replay)).candidateDigest, failed.candidateDigest)
  await Promise.all(
    [item.root, original].map((dir) => assert.rejects(readFile(join(dir, 'dirty')))),
  )

  const common = { mode: 'benchmark', metric: 'bytes', argv: input.argv, firstSeed: 4, count: 2 }
  const bench = await invoke(common)
  assert.deepEqual(bench.comparison, { metric: 'bytes', originalMedian: 4.5, candidateMedian: 2.5 })
  const receipt = JSON.parse(await readFile(join(item.base, bench.receipt), 'utf8'))
  assert.deepEqual(receipt.samples, [
    { seed: 4, original: 4, candidate: 0 },
    { seed: 5, original: 5, candidate: 5 },
  ])

  await writeFile(join(item.root, 'oracle.cjs'), reference)
  const repaired = await invoke(failed.replay)
  assert.equal(repaired.status, 'passed')
  assert.notEqual(repaired.snapshot, failed.snapshot)
  const missingCommand = await invoke({ ...input, argv: ['pi-missing-command-fixture', '{seed}'] })
  assert.equal(missingCommand.status, 'blocked')

  const unavailable = await verifyLoop({ ...request, originals: undefined }, common)
  assert.equal(unavailable.status, 'blocked')
  const skipped = await invoke({ ...input, mode: 'seeded', argv: ['echo', '# SKIP {seed}'] })
  assert.equal(skipped.status, 'skipped')
  const timeout = await invoke({ ...input, argv: ['sh', '-c', 'sleep 2', '{seed}'], timeoutMs: 10 })
  assert.equal(timeout.status, 'blocked')
  const truncated = await invoke({
    ...input,
    argv: ['node', '-e', "console.log('x'.repeat(65000))", '{seed}'],
  })
  assert.equal(truncated.status, 'blocked')
  await assert.rejects(invoke({ ...input, count: 129 }), /Invalid verification/)
})
