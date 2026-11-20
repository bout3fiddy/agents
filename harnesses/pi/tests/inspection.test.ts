import harness from '../src/extension.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { reviewReceipts } from '../src/inspection.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { delegationDirectory } from '../src/delegation-state.ts'

test('attempt summaries preserve required findings and failed checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-inspection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StateStore(root)
  const id = randomUUID()
  const dir = delegationDirectory(store, id)
  const name = 'orchestrator-1-2.json'
  await atomicJson(join(dir, 'status.json'), { status: 'running', progressFile: name })
  const missing = await reviewReceipts(store, id)
  assert.equal(missing.checks, null)
  assert.equal(missing.reviews, null)
  const finding = {
    severity: 'required',
    location: 'ledger',
    problem: 'wrong total',
    evidence: '2 != 3',
  }
  const child = (role: string, snapshot: string) => ({
    evidence: {
      role,
      snapshot,
      model: 'test',
      result: { verdict: 'changes', findings: [finding, { ...finding, severity: 'suggestion' }] },
    },
  })
  await atomicJson(join(dir, name + '.children.json'), [
    child('reviewer', 'a'),
    child('database-reviewer', 'b'),
  ])
  await atomicJson(join(dir, name + '.checks.json'), [
    { check: 'lint', snapshot: 'b', status: 'failed', result: { output: 'broken', exitCode: 1 } },
  ])
  const summary = await reviewReceipts(store, id)
  assert.deepEqual(
    summary.reviews?.map((r) => [r.snapshot, r.required]),
    [
      ['a', [finding]],
      ['b', [finding]],
    ],
  )
  assert.equal(summary.checks?.[0]?.status, 'failed')
  await rm(join(dir, name + '.checks.json'))
  await symlink(join(dir, 'status.json'), join(dir, name + '.checks.json'))
  await assert.rejects(reviewReceipts(store, id), /Linked/)
})

test('the host SDK allows nested reads and blocks nested writes in the same script', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  let response = ''
  const code = [
    'const r = await tools.task_status({});',
    'text(r);',
    'text("nested shell: " + ("bash" in tools));',
    'text("lists shell: " + ALL_TOOLS.some(tool => tool.name === "bash"));',
    'try { await tools.write({path:"unexpected",content:"incorrect"}) }',
    'catch (error) { text(String(error)) }',
  ].join(' ')
  let called = false
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [harness],
    async (ctx) => {
      if (called) {
        response = JSON.stringify(ctx.messages.at(-1))
        return [{ type: 'text', text: 'done' }]
      }

      called = true
      return [{ type: 'toolCall', name: 'codemode', id: 'inspection', arguments: { code } }]
    },
  )

  try {
    await session.prompt('Inspect active tasks')
    assert.match(response, /Script completed/)
    assert.match(response, /nested shell: false/)
    assert.match(response, /lists shell: false/)
    await assert.rejects(access(join(item.root, 'unexpected')), { code: 'ENOENT' })
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('a verdict-only script retains a failed check on the reviewed snapshot', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const id = randomUUID()
  const dir = delegationDirectory(new StateStore(item.root), id)
  const attempt = 'orchestrator-1-1.json'
  await atomicJson(join(dir, 'status.json'), { status: 'needs_attention', progressFile: attempt })
  await atomicJson(join(dir, attempt + '.children.json'), [
    {
      evidence: {
        role: 'reviewer',
        model: 'fixture',
        snapshot: 'reviewed-head',
        result: { verdict: 'pass', findings: [] },
      },
    },
  ])
  await atomicJson(join(dir, attempt + '.checks.json'), [
    {
      check: 'harness-lint',
      status: 'failed',
      snapshot: 'reviewed-head',
      result: { output: 'raw diagnostic text', exitCode: 1 },
    },
  ])
  const code =
    'const v=await tools.review_receipts({id:' +
    JSON.stringify(id) +
    '});' +
    'text([v.state,v.reviews.slice(-1).map(x=>x.verdict)])'
  let response = ''
  let called = false
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [harness],
    async (ctx) => {
      if (called) {
        response = JSON.stringify(ctx.messages.at(-1)?.content)
        return [{ type: 'text', text: 'done' }]
      }

      called = true
      return [{ type: 'toolCall', name: 'codemode', id: 'replay', arguments: { code } }]
    },
  )

  try {
    await session.prompt('Read the final review verdict.')
    assert.match(response, /pass/)
    assert.match(response, /harness-lint/)
    assert.match(response, /failed/)
    assert.match(response, /reviewed-head/)
    assert.doesNotMatch(response, /raw diagnostic text/)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})
