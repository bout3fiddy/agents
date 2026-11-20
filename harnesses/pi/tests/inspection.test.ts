import harness from '../src/extension.ts'
import { explicitResources } from '../src/worker.ts'
import { fileTools } from '../src/file-tools.ts'
import { loadRole } from '../src/roles.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { memoryRepository } from '../src/memory-repository.ts'
import { repositoryStore } from '../src/memory-files.ts'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { roleNames } from '../src/contracts.ts'
import { workerInspectionTools } from '../src/inspection-mode.ts'
import { reviewReceipts, nestedInspectionTools } from '../src/inspection.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { delegationDirectory } from '../src/delegation-state.ts'

test('every role tool has an explicit inspection or direct-call policy', async () => {
  const roles = await Promise.all(roleNames.map((name) => loadRole(name)))
  const direct = [
    'WebFetch',
    'WebSearch',
    'bash',
    'codemode',
    'consult_design',
    'delegate_branches',
    'delegate_reviews',
    'delegate_task',
    'delegate_worker',
    'design_consultation',
    'document_check',
    'edit',
    'merge_branches',
    'project_delete',
    'project_edit',
    'project_format',
    'project_write',
    'recurring_task',
    'report_milestone',
    'report_progress',
    'resume_task',
    'revise_tasks',
    'run_checks',
    'run_command',
    'submit_result',
    'task_control',
    'update_project_memory',
    'workflow',
    'write',
  ]
  const inspected = new Set([...nestedInspectionTools, ...workerInspectionTools])

  for (const name of direct) {
    assert.ok(!inspected.has(name), name)
  }

  assert.deepEqual(new Set(roles.flatMap((role) => role.tools)), new Set([...inspected, ...direct]))

  for (const role of roles) {
    assert.equal(role.tools.includes('codemode'), role.backend === 'pi', role.name)
  }
})

test('one scripted PR inspection returns check-run and commit-status links', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const originalPath = process.env.PATH!
  process.env.PATH = item.base + ':' + originalPath
  t.after(() => {
    process.env.PATH = originalPath
  })
  await writeFile(
    join(item.base, 'gh'),
    [
      '#!/bin/sh',
      'set -eu',
      'cd "$(dirname "$0")"',
      'echo "$3" >> calls',
      'echo "$7" | tr , "\\n" | grep -qx baseRefOid',
      'echo "$7" | tr , "\\n" | grep -qx baseRefName',
      'exec /usr/bin/jq -c "$9" pr.json',
    ].join('\n'),
    { mode: 0o755 },
  )
  await atomicJson(join(item.base, 'pr.json'), {
    number: 44,
    headRefOid: 'fixture-head',
    baseRefOid: 'fixture-base',
    baseRefName: 'release',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviews: [],
    statusCheckRollup: [
      { name: 'CI', conclusion: 'FAILURE', detailsUrl: 'https://example.org/runs/44' },
      { context: 'legacy', state: 'ERROR', targetUrl: 'https://example.org/status/44' },
      { name: 'queued', status: 'QUEUED' },
    ],
  })
  const code = [
    'const pr = await tools.inspect_pr({repository:"fixture/project",number:44});',
    'text([pr.baseRefName,pr.baseRefOid,pr.headRefOid]);',
    'text(pr.statusCheckRollup.map(c=>c.detailsUrl ?? c.targetUrl ?? null));',
  ].join('')
  let reply = ''
  let called = false
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [harness],
    async (ctx) => {
      if (called) {
        reply = JSON.stringify(ctx.messages.at(-1)?.content)
        return [{ type: 'text', text: 'done' }]
      }

      called = true
      return [{ type: 'toolCall', name: 'codemode', id: 'pr-checks', arguments: { code } }]
    },
  )

  try {
    await session.prompt('Locate these checks on the current head.')
    assert.match(reply, /release.*fixture-base.*fixture-head/)
    assert.match(reply, /example.org\/runs\/44.*example.org\/status\/44.*null/)
    assert.equal(await readFile(join(item.base, 'calls'), 'utf8'), '44\n')
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
})

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

test('inspection selects final checks for this attempt, including older local tasks', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const store = new StateStore(item.root)
  const id = randomUUID()
  const dir = delegationDirectory(store, id)
  const receipts = [
    {
      check: 'lint',
      status: 'failed',
      snapshot: 'final',
      result: { output: 'lint error' },
      inheritedLintPaths: ['existing.md'],
    },
  ]
  await atomicJson(join(dir, 'request.json'), { kind: 'maintenance' })
  await atomicJson(join(dir, 'status.json'), { status: 'needs_attention', receipts })
  const final = (await reviewReceipts(store, id)).checks?.[0]
  assert.equal(final?.snapshot, 'final')
  assert.ok('inheritedLintPaths' in final)
  assert.deepEqual(final.inheritedLintPaths, ['existing.md'])

  const progressFile = 'orchestrator-2-1.json'
  const checkFile = join(dir, progressFile + '.checks.json')
  await atomicJson(join(dir, 'request.json'), { kind: 'branch' })
  await atomicJson(join(dir, 'status.json'), { status: 'running', progressFile, receipts })
  assert.equal((await reviewReceipts(store, id)).checks, null)
  await atomicJson(checkFile, [{ check: 'lint', status: 'passed', snapshot: 'provisional' }])
  const state = { status: 'needs_attention', progressFile, receipts, receiptAttempt: progressFile }
  await atomicJson(join(dir, 'status.json'), state)
  assert.equal((await reviewReceipts(store, id)).checks?.[0]?.status, 'failed')
  await atomicJson(join(dir, 'status.json'), { ...state, progressFile: 'orchestrator-3-1.json' })
  assert.equal((await reviewReceipts(store, id)).checks, null)
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
        result: {
          verdict: 'changes',
          findings: [
            {
              severity: 'required',
              location: 'api/claim',
              problem: 'Retain the required check',
              evidence: 'fixture',
            },
          ],
        },
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
    assert.match(response, /changes/)
    assert.match(response, /Retain the required check/)
    assert.match(response, /harness-lint/)
    assert.match(response, /failed/)
    assert.match(response, /reviewed-head/)
    assert.doesNotMatch(response, /raw diagnostic text/)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('host scripts receive typed task, harness, history and file reads', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  execFileSync('git', ['-C', item.root, 'init', '--quiet'])
  const repo = await memoryRepository(item.root)
  assert.ok(repo)
  const memory = repositoryStore(repo)

  try {
    memory.update([
      {
        key: 'scope',
        revision: 0,
        kind: 'decision',
        text: 'Use fixture',
        source: 'fixture.md',
        quote: 'Use fixture',
        paths: ['lookup:fixture.md'],
      },
    ])
  } finally {
    memory.close()
  }

  const id = randomUUID()
  const dir = delegationDirectory(new StateStore(item.root), id)
  await atomicJson(join(dir, 'status.json'), { id, status: 'running', updatedAt: 'now' })
  await atomicJson(join(dir, 'request.json'), {
    id,
    kind: 'research',
    root: new StateStore(item.root).projectRoot,
    task: 'Test status',
    writePaths: [],
  })
  await writeFile(join(item.root, 'lookup:fixture.md'), 'Read this marker\n')
  const code = [
    'const [job,cap,harness,history,search,receipt] = await Promise.all([',
    'tools.task_status({id:' + JSON.stringify(id) + '}),tools.harness_capabilities({}),',
    'tools.harness_status({}),tools.project_memory_history({key:"scope"}),',
    'tools.project_search({query:"this marker",pathPrefix:"lookup:"}),',
    'tools.review_receipts({id:' + JSON.stringify(id) + '})]);',
    'text([receipt,job].map(x=>[x.state,x.status].join("/")).join(","));',
    'const hit=search.hits[0];',
    'const file=await tools.project_read({path:hit.path,startLine:hit.line});',
    'text([job.status,Array.isArray(cap.host.tasks),!!harness.runtime.version,',
    'history[0].paths[0]===hit.path,hit.path,search.hasMore,',
    'file.content.includes("Read this marker")]);',
  ].join('')
  let response = ''
  let called = false
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [harness],
    async (ctx) => {
      if (!called) {
        called = true
        return [{ type: 'toolCall', id: 'typed', name: 'codemode', arguments: { code } }]
      }

      response = JSON.stringify(ctx.messages.at(-1)?.content)
      return [{ type: 'text', text: 'done' }]
    },
  )

  try {
    await session.prompt('Inspect the fixture.')
    assert.match(response, /Script completed/)
    assert.match(response, /running\/running,running\/running/)
    assert.match(response, /running.*true,true,true.*lookup:fixture.md.*false,true/)
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('Pi worker scripts expose only scoped inspections', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'target.md'), 'unchanged')
  const role = await loadRole('implementer')
  const code = [
    'const names=ALL_TOOLS.map(t=>t.name).sort();',
    'const expected=["project_read","project_search"];',
    'if(names.some(n=>!expected.includes(n)))throw Error(names.join(","));',
    'const [v,s,missing]=await Promise.allSettled([tools.project_read({path:"target.md"}),',
    'tools.project_search({query:"unchanged",pathPrefix:"target.md"}),',
    'tools.project_read({path:"missing.md"})]);',
    'text([v.value.content,s.value.hits[0].line,names,missing.status]);',
    'try{await tools.project_write({path:"target.md",content:"unexpected"})}',
    'catch(e){text("write unavailable")}',
  ].join('')
  let called = false
  let response = ''
  let declaration = ''
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [],
    async (ctx) => {
      if (!called) {
        called = true
        const declared = ctx.messages.flatMap((msg) =>
          msg.role === 'system' ? (msg.toolsAdded ?? []) : [],
        )
        const tool = declared.findLast((entry) => entry.name === 'codemode')
        declaration = tool?.description ?? 'absent'
        return [{ type: 'toolCall', id: 'worker', name: 'codemode', arguments: { code } }]
      }

      response = JSON.stringify(ctx.messages.at(-1)?.content)
      return [{ type: 'text', text: 'done' }]
    },
    {
      tools: role.tools,
      customTools: fileTools(item.root, ['**'], ['**']),
      resourceLoader: await explicitResources('Use only assigned tools.'),
    },
  )

  try {
    await session.prompt('Inspect the worker catalog.')
    assert.match(declaration.slice(0, 230), /Available tools: .*project_read/)
    assert.match(declaration, /Call shell commands, tests, edits/)
    assert.match(response, /Script completed/)
    assert.match(response, /unchanged/)
    assert.match(response, /rejected/)
    assert.match(response, /write unavailable/)
    assert.ok(!(await loadRole('implementer', 'medium', 'opus')).tools.includes('codemode'))
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('scoped workers can recover stored pages and see failed reads after truncation', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'large.txt'), 'start' + 'x'.repeat(12000) + 'stored-end')
  const role = await loadRole('implementer')
  const outputs: string[] = []
  const scripts = [
    [
      '// @options: {"max_output_tokens": 256}',
      'const file = await tools.project_read({path:"large.txt"});',
      'store("large",file.content);',
      'try { await tools.project_read({path:"missing-file.txt"}) } catch {}',
      'text(file.content);',
    ].join('\n'),
    'text(load("large").slice(-10))',
    'text(await Promise.allSettled([tools.project_read({path:"unavailable.ts"})]))',
  ]
  let step = 0
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [],
    async (ctx) => {
      if (step) {
        outputs.push(JSON.stringify(ctx.messages.at(-1)?.content))
      }

      const code = scripts[step++]
      return code
        ? [{ type: 'toolCall', id: 'page-' + step, name: 'codemode', arguments: { code } }]
        : [{ type: 'text', text: 'done' }]
    },
    {
      tools: role.tools,
      customTools: fileTools(item.root, ['**'], ['**']),
      resourceLoader: await explicitResources('Read the assigned fixture.'),
    },
  )

  try {
    await session.prompt('Inspect this file.')
    assert.match(outputs[0]!, /truncated output/)
    assert.doesNotMatch(outputs[0]!, /read with offset\/limit/)
    assert.match(outputs[0]!, /load\(/)
    assert.match(outputs[0]!, /project_read.*missing-file.txt/)
    assert.match(outputs[1]!, /stored-end/)
    assert.doesNotMatch(outputs[1]!, /Failed or cancelled/)
    assert.doesNotMatch(outputs[2]!, /truncated output/)
    assert.match(outputs[2]!, /project_read.*unavailable.ts.*error.*ENOENT/)
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
})
