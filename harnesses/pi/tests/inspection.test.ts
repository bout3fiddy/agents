import harness, { createHarness } from '../src/extension.ts'
import { explicitResources } from '../src/worker.ts'
import { fileTools } from '../src/file-tools.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import assert from 'node:assert/strict'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { roleNames } from '../src/contracts.ts'
import { directOnly, workerInspectionTools } from '../src/inspection-mode.ts'

test('the host scripts every tool except the shell and file writes', async () => {
  const roles = await Promise.all(roleNames.map((name) => loadRole(name)))
  const orchestrator = roles.find((role) => role.name === 'orchestrator')!
  const scriptable = orchestrator.tools.filter((name) => !directOnly.has(name))
  assert.deepEqual([...directOnly].sort(), ['bash', 'codemode', 'edit', 'write'])

  for (const name of ['job_start', 'job_status', 'job_message', 'job_retry', 'job_close']) {
    assert.ok(scriptable.includes(name), name)
  }

  assert.ok(!orchestrator.tools.some((name) => /cancel|pause/.test(name)))

  for (const role of roles) {
    assert.equal(role.tools.includes('codemode'), role.backend === 'pi', role.name)
    assert.equal(role.tools.includes('whiteboard'), role.name === 'orchestrator', role.name)
    assert.equal(role.tools.includes('job_start'), role.name === 'orchestrator', role.name)

    for (const name of workerInspectionTools) {
      assert.ok(role.name === 'orchestrator' || !directOnly.has(name))
    }
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
      'if [ "$2" = graphql ]; then cat queue.json; exit 0; fi',
      'echo "$7" | tr , "\\n" | grep -qx baseRefOid',
      'echo "$7" | tr , "\\n" | grep -qx baseRefName',
      'exec /usr/bin/jq -c "$9" pr.json',
    ].join('\n'),
    { mode: 0o755 },
  )
  await atomicJson(join(item.base, 'pr.json'), {
    number: 44,
    headRefOid: 'a'.repeat(40),
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
  const queue = {
    number: 44,
    state: 'OPEN',
    headRefOid: 'a'.repeat(40),
    isInMergeQueue: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  await atomicJson(join(item.base, 'queue.json'), queue)
  let code = [
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
        reply = JSON.stringify(
          ctx.messages.findLast((message) => message.role === 'toolResult')?.content,
        )
        return [{ type: 'text', text: 'done' }]
      }

      called = true
      return [{ type: 'toolCall', name: 'codemode', id: 'pr-checks', arguments: { code } }]
    },
  )

  try {
    await session.prompt('Locate these checks on the current head.')
    assert.match(reply, /release.*fixture-base.*a{40}/)
    assert.match(reply, /example.org\/runs\/44.*example.org\/status\/44.*null/)
    assert.equal(await readFile(join(item.base, 'calls'), 'utf8'), '44\n')
    code =
      'const p=await tools.inspect_pr({repository:"fixture/project",number:44,' +
      'includeQueue:true});text([p.isInMergeQueue,p.mergeStateStatus])'
    called = false
    await session.prompt('Is GitHub actually queuing it?')
    assert.match(reply, /false.*CLEAN/)
    await atomicJson(join(item.base, 'queue.json'), { ...queue, headRefOid: 'b'.repeat(40) })
    called = false
    await session.prompt('Recheck the refreshed candidate.')
    assert.match(reply, /PR changed during inspection/)
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('the host SDK allows nested reads and blocks nested writes in the same script', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  let response = ''
  const code = [
    'const r = await tools.job_status({});',
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
        response = JSON.stringify(ctx.messages.findLast((message) => message.role === 'toolResult'))
        return [{ type: 'text', text: 'done' }]
      }

      called = true
      return [{ type: 'toolCall', name: 'codemode', id: 'inspection', arguments: { code } }]
    },
  )

  try {
    await session.prompt('Inspect active jobs')
    assert.match(response, /Script completed/)
    assert.match(response, /nested shell: false/)
    assert.match(response, /lists shell: false/)
    await assert.rejects(access(join(item.root, 'unexpected')), { code: 'ENOENT' })
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('one host script starts jobs idempotently and chains typed reads', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'lookup:fixture.md'), 'Read this marker\n')
  const job = { title: 'Count', task: 'Count files.', mode: 'research', key: 'count' }
  const code = [
    'const started = await Promise.all([1,2,3].map(() => tools.job_start(' + JSON.stringify(job),
    ')));',
    'const [status,search] = await Promise.all([tools.job_status({}),',
    'tools.project_search({query:"this marker",pathPrefix:"lookup:"})]);',
    'const hit=search.hits[0];',
    'const file=await tools.project_read({path:hit.path,startLine:hit.line});',
    'text([new Set(started.map(x=>x.id)).size,status.jobs.length,status.jobs[0].status,',
    'hit.path,file.content.includes("Read this marker")]);',
    'try { await tools.job_close({id:"j1",reason:"superseded"}) }',
    'catch (error) { text(String(error)) }',
  ].join('')
  let response = ''
  let called = false
  const launched: string[] = []
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [createHarness({ jobs: { launch: async (_store, id) => void launched.push(id) } })],
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
    await session.prompt('Start the count and inspect the fixture.')
    assert.match(response, /Script completed/)
    assert.match(response, /1,1,.*queued.*lookup:fixture.md.*true/)
    assert.match(response, /only the user stops running work|Only a needs_attention job/i)
    assert.equal(launched.length, 1, 'three starts with one key launch one runner')
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
    assert.match(
      declaration,
      /Read-only inspection script\. Available tools: project_read, project_search\./,
    )
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
