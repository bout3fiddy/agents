import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ProviderQuotaError, type WorkerResult } from '../src/contracts.ts'
import type { Dispatcher } from '../src/dispatch.ts'
import { createWorkspace } from '../src/project.ts'
import { gitCommand } from '../src/git-branches.ts'
import { loadRole } from '../src/roles.ts'
import { createWorkerTools } from '../src/worker-tools.ts'
import {
  createTaskCoordinatorTools,
  designReference,
  runTaskCoordinator,
  scopeContained,
  type TaskCoordinatorRequest,
} from '../src/task-coordinator.ts'
import { validateDelegation } from '../src/delegation-state.ts'
import { readProgress, trackDispatch } from '../src/progress.ts'
import { evidence, fixture, hashes } from './support.ts'

const pass: WorkerResult = {
  verdict: 'pass',
  summary: 'Task complete',
  findings: [],
  databaseImpact: false,
  evidence: ['Scoped fixture evidence'],
}
const leaf = { role: 'task-worker', task: 'Update scoped file', writePaths: ['src/**'] }

async function setup(t: TestContext) {
  const { base, root, store } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const request: TaskCoordinatorRequest = {
    task: 'Update a bounded document',
    context: 'Preserve unrelated work',
    kind: 'documents',
    workspace: root,
    project: { root, checks: [], databasePaths: [], instrumentationPaths: [] },
    checkpoint: (await store.checkpoint())!,
    model: 'openai-codex/gpt-6.1-sol',
    outputPath: join(root, '.pi', 'traces', 'task', 'result.json'),
    baseline: await hashes(root),
    originals: root,
  }
  const controller = new AbortController()
  return { request, controller }
}

async function receipt(request: Parameters<Dispatcher>[0], result: Partial<WorkerResult> = {}) {
  const role = await loadRole(request.role)
  return {
    ...(await evidence(request, result)),
    model: role.backend === 'claude-cli' ? `claude-cli/${role.model}` : role.model,
  }
}

function invoke(tools: ToolDefinition[], name: string, args: unknown) {
  const tool = tools.find((item) => item.name === name)!
  return tool.execute(
    'fixture',
    args,
    undefined,
    undefined,
    {} as Parameters<ToolDefinition['execute']>[4],
  )
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function swarm(ids: string[], role = 'task-worker') {
  return {
    role,
    task: 'Survey the fixture; every researcher works independently',
    writePaths: [],
    researchers: ids.map((id) => ({ id, task: `Investigate ${id}` })),
  }
}

function researcherOf(child: Parameters<Dispatcher>[0]): string | undefined {
  return JSON.parse(child.task).research?.researcher
}

function report(result: Awaited<ReturnType<typeof invoke>>) {
  const [text] = result.content
  assert.ok(text?.type === 'text')
  return JSON.parse(text.text)
}

/** Give queued tool calls real file-system round trips to advance, without wall-clock waits.
 * A call that could reach its dispatcher needs far fewer than these. */
async function advance(path: string) {
  for (let trip = 0; trip < 200; trip++) {
    await stat(path)
  }
}

test('scope containment handles exact paths, subtrees and invalid traversal', () => {
  assert.ok(scopeContained(['docs/a.md', 'docs/nested/**'], ['docs/**']))
  assert.ok(scopeContained([], ['docs/**']))
  assert.ok(scopeContained(['docs/**'], ['**']))
  assert.equal(scopeContained(['**'], ['docs/**']), false)
  assert.equal(scopeContained(['docs/**'], ['docs']), false)
  assert.equal(scopeContained(['docs-more/a.md'], ['docs/**']), false)
  assert.throws(() => scopeContained(['docs/../secret'], ['**']))
  assert.throws(() => scopeContained(['docs/*/draft.md'], ['docs/**']), /exact filenames/)
  assert.throws(() => scopeContained(['docs/*/**'], ['docs/**']), /exact filenames/)
  const legacyParent = ['docs/local/**', 'docs/draft_*.md']
  assert.ok(scopeContained(['docs/local/a.md'], legacyParent))
  assert.equal(scopeContained(['docs/draft_a.md'], legacyParent), false)
  assert.ok(scopeContained(['docs/[slug]/page.md'], ['docs/**']))
})

test('coordinator exposes bounded delegation and no retained write tools', async (t) => {
  const { request, controller } = await setup(t)
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    dispatched++
    assert.deepEqual(child.checkpoint.writePaths, ['src/value.js'])
    return receipt(child)
  })
  assert.equal(
    worker.tools.some((tool) => tool.name === 'project_write'),
    false,
  )
  assert.equal(
    worker.tools.some((tool) => tool.name === 'project_delete'),
    false,
  )
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', {
      ...leaf,
      role: 'task-coordinator',
    }),
    /Invalid leaf/,
  )
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', {
      ...leaf,
      writePaths: ['**'],
    }),
    /scope exceeds/,
  )
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', {
      ...leaf,
      role: 'reviewer',
    }),
    /Invalid leaf/,
  )
  await invoke(worker.tools, 'delegate_worker', { ...leaf, writePaths: ['src/value.js'] })
  assert.equal(dispatched, 1)
  const summary = 'The restart test restored all saved entries. Migration work can proceed.'
  await invoke(worker.tools, 'report_milestone', { summary })
  await invoke(worker.tools, 'report_progress', { summary: 'Inspecting the follow-up document.' })
  await worker.progress.update({ stage: 'coordinating' })
  const progress = await readProgress(request.outputPath)
  assert.equal(progress?.milestone, summary)
  assert.equal(progress?.summary, 'Inspecting the follow-up document.')
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /already submitted/)
})

test('workers read legacy briefs only from their snapshots', async (t) => {
  const { request } = await setup(t)
  const root = request.project.root
  const path = '.pi/project-state.md'
  await writeFile(join(root, path), 'Snapshot decision')
  const privateDir = join(root, '.pi/local-memory')
  await mkdir(privateDir)
  await writeFile(join(privateDir, 'memory.sqlite'), 'Private evidence')
  const workspace = await createWorkspace(root)
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(root, path), 'Changed after snapshot')
  const { tools } = createWorkerTools(
    { ...request, workspace, originals: workspace, role: 'implementer' },
    await loadRole('implementer'),
  )

  for (const name of ['project_read', 'original_read']) {
    const result = await invoke(tools, name, { path })
    const output = JSON.parse((result.content[0] as { text: string }).text)
    assert.equal(output.content, '1: Snapshot decision')
    await assert.rejects(invoke(tools, name, { path: '.pi/local-memory/memory.sqlite' }))
  }

  await assert.rejects(readFile(join(workspace, '.pi/local-memory/memory.sqlite')), {
    code: 'ENOENT',
  })
  await rm(join(workspace, path))
  await assert.rejects(invoke(tools, 'project_read', { path }), { code: 'ENOENT' })
})

test('mixed unsupported formatting leaves earlier files intact', async (t) => {
  const { request } = await setup(t)
  const worker = createWorkerTools(
    { ...request, role: 'implementer' },
    await loadRole('implementer'),
  )
  const path = join(request.workspace, 'src/value.js')
  const source = 'export const value=1;\n'
  await writeFile(path, source)
  await writeFile(join(request.workspace, 'src/value.py'), 'value = 1\n')
  await assert.rejects(
    invoke(worker.tools, 'project_format', {
      paths: ['src/value.js', 'src/value.py'],
    }),
    /No parser/,
  )
  assert.equal(await readFile(path, 'utf8'), source)
})

test('Markdown and source formatters agree on fenced TypeScript', async (t) => {
  const { request } = await setup(t)
  const worker = createWorkerTools(
    { ...request, role: 'task-worker' },
    await loadRole('task-worker'),
  )
  const path = 'src/guide.md'
  const absolute = join(request.workspace, path)
  const canonical = ['# Usage', '', '```ts', "client.release('pending')", '```', ''].join('\n')
  const unformatted = canonical.replace("release('pending')", 'release("pending");')

  await writeFile(absolute, unformatted)
  await invoke(worker.tools, 'project_format', { paths: [path] })
  assert.equal(await readFile(absolute, 'utf8'), canonical)
  const checked = await invoke(worker.tools, 'document_check', { paths: [path] })
  const checkContent = checked.content[0]
  assert.ok(checkContent?.type === 'text')
  assert.equal(JSON.parse(checkContent.text).status, 'passed')

  await writeFile(absolute, unformatted)
  await invoke(worker.tools, 'document_check', { paths: [path], format: true })
  assert.equal(await readFile(absolute, 'utf8'), canonical)
  await invoke(worker.tools, 'project_format', { paths: [path] })
  assert.equal(await readFile(absolute, 'utf8'), canonical)
})

test('task-worker can retain scoped edits but cannot delegate', async (t) => {
  const { request } = await setup(t)
  const role = await loadRole('task-worker')
  const worker = createWorkerTools({ ...request, role: 'task-worker' }, role)
  assert.equal(role.mayDelegate, false)
  assert.equal(
    worker.tools.some((tool) => tool.name === 'delegate_worker'),
    false,
  )
  await invoke(worker.tools, 'project_write', { path: 'src/value.js', content: 'updated\n' })
  await assert.rejects(
    invoke(worker.tools, 'project_write', {
      path: 'outside.md',
      content: 'unauthorized',
    }),
    /outside this worker assignment/,
  )
})

test('concurrent child calls serialize and unfinished children prevent submission', async (t) => {
  const { request, controller } = await setup(t)
  let active = 0
  let maximum = 0
  let count = 0
  let release!: () => void
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    active++
    maximum = Math.max(maximum, active)
    count++

    if (count === 1) {
      started()
      await blocked
    }

    await writeFile(join(request.workspace, 'src/value.js'), `change ${count}\n`)
    const result = await receipt(child)
    active--
    return result
  })
  const first = invoke(worker.tools, 'delegate_worker', leaf)
  await firstStarted
  const second = invoke(worker.tools, 'delegate_worker', leaf)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Wait for all/)
  release()
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(worker.children().length, 2)
  await invoke(worker.tools, 'submit_result', pass)
})

test('ordinary coordinators continue beyond the former eight-child limit', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, (child) =>
    receipt(child),
  )

  for (let index = 0; index < 12; index++) {
    await invoke(worker.tools, 'delegate_worker', leaf)
  }

  assert.equal(worker.children().length, 12)
  await invoke(worker.tools, 'submit_result', pass)
})

test('completed performance work survives 46 turns without duplication', async (t) => {
  const { request, controller } = await setup(t)
  request.checkpoint.performanceReview = true
  let reviews = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    reviews++
    return { ...(await receipt(child)), turns: 46 }
  })
  await invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'performance', writePaths: [] })
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(reviews, 1)
  assert.equal(worker.children()[0]?.turns, 46)
})

test('a transient failed child can recover in the same scope', async (t) => {
  const { request, controller } = await setup(t)
  let calls = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    if (calls++ === 0) {
      throw new Error('Provider temporarily unavailable')
    }

    return receipt(child)
  })
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /temporarily unavailable/)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('stale child receipt poisons passing completion', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => ({
    ...(await receipt(child)),
    snapshot: 'stale',
  }))
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /Stale or mismatched/)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
  await invoke(worker.tools, 'submit_result', { ...pass, verdict: 'blocked' })
  assert.equal(worker.result()?.verdict, 'blocked')
})

test('performance worker cannot retain product edits', async (t) => {
  const { request, controller } = await setup(t)
  request.checkpoint.performanceReview = true
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    await writeFile(join(request.workspace, 'src/value.js'), 'unauthorized\n')
    return receipt(child)
  })
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'performance' }),
    /outside its role or assignment/,
  )
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
})

test('required findings need a same-role passing child on the final candidate', async (t) => {
  const { request, controller } = await setup(t)
  let calls = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    calls++

    if (calls === 1) {
      return receipt(child, {
        verdict: 'changes',
        findings: [
          {
            severity: 'required',
            location: 'src/value.js',
            problem: 'Fix wording',
            evidence: 'The fixture wording is wrong',
          },
        ],
      })
    }

    assert.match(child.task, /Fix wording/)
    await writeFile(join(request.workspace, 'src/value.js'), 'fixed\n')
    return receipt(child)
  })
  await invoke(worker.tools, 'delegate_worker', leaf)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Resolve child findings/)
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('completion identifies unresolved worker scope', async (t) => {
  const { request, controller } = await setup(t)
  let calls = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    calls++
    return receipt(child, calls === 1 ? { verdict: 'blocked' } : {})
  })
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'delegate_worker', { ...leaf, writePaths: [] })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), (error: Error) => {
    assert.match(error.message, /"role":"task-worker","writePaths":\["src\/\*\*"\]/)
    assert.match(error.message, /"verdict":"blocked","snapshotMatches":true/)
    assert.match(error.message, /exact role and writePaths/)
    return true
  })
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('cancellation reaches the dispatcher and blocks subsequent completion', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(
    request,
    controller.signal,
    async (_child, signal) => {
      assert.equal(signal, controller.signal)
      controller.abort(new Error('fixture cancellation'))
      signal!.throwIfAborted()
      throw new Error('unreachable')
    },
  )
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /fixture cancellation/)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /fixture cancellation/)
})

test('control updates invalidate submitted completion', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, (child) =>
    receipt(child),
  )
  await invoke(worker.tools, 'submit_result', pass)
  worker.invalidateResult()
  assert.equal(worker.result(), undefined)
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('trace paths cannot be placed in candidate snapshots', async (t) => {
  const { request, controller } = await setup(t)
  await mkdir(join(request.workspace, 'child-traces'))
  await assert.rejects(
    runTaskCoordinator(
      {
        ...request,
        outputPath: join(request.workspace, 'child-traces', 'result.json'),
      },
      controller.signal,
    ),
    /original project private trace directory/,
  )
})

test('document checks format assigned files and reject every out-of-scope write', async (t) => {
  const { request, controller } = await setup(t)
  await writeFile(join(request.workspace, 'src/note.md'), '# Note\n\nbody')
  await writeFile(join(request.workspace, 'outside.md'), '# Outside\n\nbody')
  const worker = createWorkerTools(
    { ...request, role: 'task-worker' },
    await loadRole('task-worker'),
  )
  await assert.rejects(
    invoke(worker.tools, 'document_check', {
      paths: ['src/note.md', 'outside.md'],
      format: true,
    }),
    /outside this worker assignment/,
  )
  assert.equal(await readFile(join(request.workspace, 'src/note.md'), 'utf8'), '# Note\n\nbody')
  await invoke(worker.tools, 'document_check', { paths: ['src/note.md'], format: true })
  const checked = await invoke(worker.tools, 'document_check', { paths: ['src/note.md'] })
  assert.match(JSON.stringify(checked), /passed/)
  const coordinator = await createTaskCoordinatorTools(request, controller.signal, (child) =>
    receipt(child),
  )
  await assert.rejects(
    invoke(coordinator.tools, 'document_check', {
      paths: ['src/note.md'],
      format: true,
    }),
    /outside this worker assignment/,
  )
  assert.match(
    JSON.stringify(
      await invoke(coordinator.tools, 'document_check', {
        paths: ['src/note.md'],
      }),
    ),
    /passed/,
  )
})

test('default routing rejects unselected specialists before dispatch', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, async () =>
    assert.fail('no specialist may launch'),
  )
  assert.equal(
    worker.tools.some((tool) => tool.name === 'delegate_reviews'),
    false,
  )

  for (const role of ['database-reviewer', 'reviewer', 'performance']) {
    await assert.rejects(
      invoke(worker.tools, 'delegate_worker', { ...leaf, role, writePaths: [] }),
      /Invalid leaf|not selected|explicit user request/,
    )
  }

  for (const retired of ['reviewer', 'database-reviewer']) {
    await assert.rejects(loadRole(retired), /Unknown role/)
  }
})

test('explicit read-only performance request requires its measurement', async (t) => {
  const { request, controller } = await setup(t)
  request.kind = 'research'
  request.checkpoint.performanceReview = true
  const worker = await createTaskCoordinatorTools(request, controller.signal, (child) =>
    receipt(child),
  )
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /performance evidence/)
  await invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'performance', writePaths: [] })
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('coordinator selects effort per child and rejects invalid levels', async (t) => {
  const { request, controller } = await setup(t)
  request.checkpoint.performanceReview = true
  const sent: unknown[] = []
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    sent.push([child.role, child.thinking])
    return receipt(child)
  })
  const tool = worker.tools.find((entry) => entry.name === 'delegate_worker')!
  const run = (role: string, thinking?: string) =>
    tool.execute(
      'effort',
      { ...leaf, role, writePaths: [], ...(thinking ? { thinking } : {}) },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    )
  await assert.rejects(run('performance', 'low'), /Unsupported thinking/)
  await assert.rejects(run('implementer', 'xhigh'), /Invalid leaf assignment/)
  await assert.rejects(run('database-reviewer', 'low'), /Invalid leaf/)
  assert.deepEqual(sent, [])
  await run('task-worker', 'low')
  await run('implementer', 'high')
  await run('performance', 'medium')
  await run('performance')
  assert.deepEqual(sent, [
    ['task-worker', 'low'],
    ['implementer', 'high'],
    ['performance', 'medium'],
    ['performance', undefined],
  ])
})

test('hard quota rejection skips repeat review launches until new host guidance', async (t) => {
  const { request, controller } = await setup(t)
  request.checkpoint.performanceReview = true
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    dispatched++

    if (dispatched === 1) {
      throw new ProviderQuotaError('Reviewer quota exhausted', Date.now() + 86400000)
    }

    return receipt(child)
  })
  const review = { role: 'performance', task: 'Review the candidate', writePaths: [] }
  await assert.rejects(invoke(worker.tools, 'delegate_worker', review), /quota exhausted/)
  await assert.rejects(invoke(worker.tools, 'delegate_worker', review), /quota exhausted/)
  assert.equal(dispatched, 1)
  worker.invalidateResult()
  await invoke(worker.tools, 'delegate_worker', review)
  assert.equal(dispatched, 2)
})

test('pinned design lookup includes nearby committed docs and bounds large indexes', () => {
  const baseline = Object.fromEntries(
    [
      'plans/scope.md',
      'plans/parts/01-core.md',
      'plans/notes.txt',
      'plans/src.js',
      'plans-old/unrelated.md',
    ].map((path) => [path, 'digest']),
  )
  assert.deepEqual(designReference('plans/scope.md', baseline), {
    path: 'plans/scope.md',
    nearbyDocuments: ['plans/notes.txt', 'plans/parts/01-core.md'],
  })
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`plan-${i}.md`, 'hash']))
  assert.deepEqual(designReference('scope.md', many), { path: 'scope.md', pathPrefix: '' })
  const long = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`plans/${'名'.repeat(45)}-${i}.md`, 'hash']),
  )
  assert.deepEqual(designReference('plans/scope.md', long), {
    path: 'plans/scope.md',
    pathPrefix: 'plans/',
  })
})

test('retained worker files must participate in the reviewed Git snapshot', async (t) => {
  const { request } = await setup(t)
  const root = request.workspace
  await gitCommand(root, ['init', '-q'])
  await gitCommand(root, ['add', 'src/value.js'])
  await writeFile(join(root, '.gitignore'), 'src/\n')
  const worker = createWorkerTools(
    { ...request, role: 'implementer' },
    await loadRole('implementer'),
  )
  const path = 'src/report.md'
  await assert.rejects(invoke(worker.tools, 'project_write', { path, content: 'lost' }), /ignored/)
  await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' })
  await writeFile(join(root, path), 'existing')

  for (const [name, args] of [
    ['project_read', { path }],
    ['project_edit', { path, oldText: 'existing', newText: 'changed' }],
    ['project_delete', { path }],
    ['project_format', { paths: [path] }],
    ['document_check', { paths: [path], format: true }],
  ] as const) {
    await assert.rejects(invoke(worker.tools, name, args), /ignored/)
  }

  assert.equal(await readFile(join(root, path), 'utf8'), 'existing')
  await invoke(worker.tools, 'project_write', { path: 'src/value.js', content: 'tracked' })
  assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'tracked')
})

test('branch coordinators apply the requested writer and accept its scoped receipt', async (t) => {
  const { request, controller } = await setup(t)
  request.kind = 'branch'
  request.implementerModel = 'opus'
  const calls: string[] = []
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    calls.push(child.role)
    assert.equal(child.implementerModel, 'opus')
    return { ...(await evidence(child)), model: 'claude-cli/claude-opus-5-5' }
  })
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /user-selected implementer/)
  await invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'implementer', thinking: 'high' })
  assert.deepEqual(calls, ['implementer'])
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'implementer', thinking: 'low' }),
    /Unsupported thinking/,
  )
})

test('explicit research and document selections dispatch a scoped Claude leaf', async (t) => {
  for (const kind of ['research', 'documents'] as const) {
    const { request, controller } = await setup(t)
    const writePaths = kind === 'research' ? [] : ['docs/report.md']
    const selection = { kind, implementerModel: 'fable' as const }
    validateDelegation({ ...selection, task: request.task, context: request.context, writePaths })
    Object.assign(request, selection)
    request.checkpoint.writePaths = writePaths
    let calls = 0
    const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
      calls++
      assert.equal(child.role, 'implementer')
      assert.equal(child.implementerModel, 'fable')
      assert.equal(child.thinking, 'high')
      assert.deepEqual(child.checkpoint.writePaths, writePaths)
      assert.equal(child.documentsOnly, kind === 'documents')
      return { ...(await evidence(child)), model: 'claude-cli/claude-fable-5-2' }
    })
    await assert.rejects(invoke(worker.tools, 'submit_result', pass), /selected implementer/)
    await invoke(worker.tools, 'delegate_worker', { ...leaf, writePaths, thinking: 'high' })
    await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /scope exceeds/)
    assert.equal(calls, 1)
    await invoke(worker.tools, 'submit_result', pass)
  }
})

test('research receipts must match the selected writer or its attributed fallback', async (t) => {
  const fable = { model: 'claude-cli/claude-fable-5-2' }
  const opus = { model: 'claude-cli/claude-opus-5-5' }
  const fallback = { ...opus, quotaFallbackFrom: 'claude-fable-5-2', thinking: 'high' as const }
  const cases = [
    { selection: 'fable', report: fable, accepted: true },
    { selection: 'fable', report: opus, accepted: false },
    { selection: 'fable', report: fallback, accepted: true },
    { selection: 'opus', report: opus, accepted: true },
    { selection: 'opus', report: fable, accepted: false },
    { selection: 'opus', report: fallback, accepted: false },
  ] as const

  for (const { selection, report: modelReport, accepted } of cases) {
    const { request, controller } = await setup(t)
    Object.assign(request, { kind: 'research', implementerModel: selection })
    request.checkpoint.writePaths = []
    const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
      assert.equal(child.role, 'implementer')
      assert.equal(child.implementerModel, selection)
      return { ...(await evidence(child)), ...modelReport }
    })
    const delegation = invoke(worker.tools, 'delegate_worker', {
      ...leaf,
      writePaths: [],
      thinking: 'high',
    })
    const label = `${selection} selection with ${JSON.stringify(modelReport)}`

    if (accepted) {
      await delegation
      await invoke(worker.tools, 'submit_result', pass)
    } else {
      await assert.rejects(delegation, /model does not match/, label)
      await assert.rejects(invoke(worker.tools, 'submit_result', pass), label)
    }
  }
})

test('coordinator accepts an Opus review only with matching fallback provenance', async (t) => {
  const { request, controller } = await setup(t)
  request.checkpoint.performanceReview = true

  for (const authorized of [true, false]) {
    const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => ({
      ...(await evidence(child)),
      model: 'claude-cli/claude-opus-5-5',
      ...(authorized && { quotaFallbackFrom: 'claude-fable-5-2' }),
    }))
    const review = invoke(worker.tools, 'delegate_worker', {
      role: 'performance',
      writePaths: [],
      task: 'Review the scoped candidate',
    })

    if (authorized) {
      await review
    } else {
      await assert.rejects(review, /model does not match/)
    }
  }
})

test('branch accepts a Fable writer fallback with matching provenance and effort', async (t) => {
  const { request, controller } = await setup(t)
  request.kind = 'branch'
  request.implementerModel = 'fable'

  for (const thinking of ['high', 'medium'] as const) {
    const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => ({
      ...(await evidence(child)),
      model: 'claude-cli/claude-opus-5-5',
      quotaFallbackFrom: 'claude-fable-5-2',
      thinking,
    }))
    const attempt = invoke(worker.tools, 'delegate_worker', {
      ...leaf,
      role: 'implementer',
      thinking: 'high',
    })

    if (thinking === 'high') {
      await attempt
    } else {
      await assert.rejects(attempt, /model does not match/)
    }
  }
})

test('a research swarm starts every researcher together and keeps the writer out', async (t) => {
  const { request, controller } = await setup(t)
  const ids = ['auth', 'storage', 'network', 'cache', 'queue', 'retry', 'audit']
  const barrier = gate()
  const release = gate()
  const started: string[] = []
  let active = 0
  let activeAtWriterStart = -1
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    const id = researcherOf(child)

    if (id === undefined) {
      activeAtWriterStart = active
      await writeFile(join(request.workspace, 'src/value.js'), 'written after research\n')
      return receipt(child)
    }

    assert.deepEqual(child.checkpoint.writePaths, [])
    assert.equal(child.role, 'task-worker')
    started.push(id)
    active++

    if (started.length === ids.length) {
      barrier.open()
    }

    await release.opened
    const result = await receipt(child, { summary: `${id} findings` })
    active--
    return result
  })
  const research = invoke(worker.tools, 'delegate_worker', swarm(ids))

  // The barrier opens only once the last researcher started while every other one still runs.
  await barrier.opened
  assert.equal(active, ids.length)
  assert.deepEqual(started, ids)
  const writer = invoke(worker.tools, 'delegate_worker', leaf)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Wait for all/)
  await advance(request.workspace)
  assert.equal(activeAtWriterStart, -1, 'the writer waits for the whole swarm')
  assert.equal(worker.children().length, 0)
  release.open()
  const result = report(await research)
  assert.deepEqual(result.swarm, {
    size: ids.length,
    completed: ids.length,
    failed: 0,
    capacityFailures: 0,
  })
  assert.deepEqual(result.unfinished, [])
  assert.deepEqual(
    result.researchers.map(
      (entry: { id: string; status: string; evidence: { result: WorkerResult } }) => [
        entry.id,
        entry.status,
        entry.evidence.result.summary,
      ],
    ),
    ids.map((id) => [id, 'completed', `${id} findings`]),
  )
  await writer
  assert.equal(activeAtWriterStart, 0, 'the writer ran alone')
  const persisted: { assignment: { researcher?: { id: string } } }[] = JSON.parse(
    await readFile(`${request.outputPath}.children.json`, 'utf8'),
  )
  assert.deepEqual(
    persisted.map((entry) => entry.assignment.researcher?.id),
    [...ids, undefined],
  )
  assert.equal(worker.children().length, ids.length + 1)
  await invoke(worker.tools, 'submit_result', pass)
})

test('a failed researcher is reported by id and blocks a pass until it completes', async (t) => {
  const { request, controller } = await setup(t)
  const dispatched: string[] = []
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    const id = researcherOf(child) ?? 'leaf'
    const earlier = dispatched.filter((entry) => entry === id).length
    dispatched.push(id)

    if (id === 'spawn' && earlier === 0) {
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })
    }

    if (id === 'crash' && earlier === 0) {
      throw new Error('Worker exited without a result')
    }

    return receipt(child, { summary: `${id} findings` })
  })
  const first = report(
    await invoke(worker.tools, 'delegate_worker', swarm(['ok', 'spawn', 'crash'])),
  )
  assert.deepEqual(first.swarm, { size: 3, completed: 1, failed: 2, capacityFailures: 1 })
  assert.deepEqual(
    first.researchers.map((entry: { id: string; status: string; capacity?: boolean }) => [
      entry.id,
      entry.status,
      entry.capacity,
    ]),
    [
      ['ok', 'completed', undefined],
      ['spawn', 'failed', true],
      ['crash', 'failed', false],
    ],
  )
  assert.match(first.researchers[1].error, /EAGAIN/)
  assert.deepEqual(first.unfinished, ['spawn', 'crash'])
  assert.match(first.instruction, /Nothing is queued/)
  assert.equal(worker.children().length, 1)
  const outstanding = /failed child execution.*Unfinished researchers: spawn, crash/
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), outstanding)

  // Neither a sibling nor a same-role, same-scope leaf can stand in for a failed researcher.
  await invoke(worker.tools, 'delegate_worker', swarm(['other']))
  await invoke(worker.tools, 'delegate_worker', { ...leaf, writePaths: [] })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), outstanding)
  const retry = report(await invoke(worker.tools, 'delegate_worker', swarm(['spawn', 'crash'])))
  assert.deepEqual(retry.unfinished, [])
  assert.equal(retry.instruction, undefined)
  assert.deepEqual(dispatched, ['ok', 'spawn', 'crash', 'other', 'leaf', 'spawn', 'crash'])
  assert.equal(worker.children().length, 5)
  await invoke(worker.tools, 'submit_result', pass)
})

test('a sibling pass never clears another researcher finding', async (t) => {
  const { request, controller } = await setup(t)
  const runs = new Map<string, number>()
  const previous: Record<string, string[]> = {}
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    const id = researcherOf(child) ?? 'leaf'
    const run = (runs.get(id) ?? 0) + 1
    runs.set(id, run)
    const findings: WorkerResult[] = JSON.parse(child.task).previousFindings
    previous[`${id}#${run}`] = findings.map((finding) => finding.summary)

    if (id === 'a' && run === 1) {
      return receipt(child, {
        verdict: 'changes',
        summary: 'a is unresolved',
        findings: [
          {
            severity: 'required',
            location: 'src/value.js',
            problem: 'Missing evidence',
            evidence: 'No source was cited',
          },
        ],
      })
    }

    return receipt(child, { summary: `${id} run ${run}` })
  })
  await invoke(worker.tools, 'delegate_worker', swarm(['a', 'b']))
  const unresolved = /Resolve child findings.*"researcher":"a".*Dispatch this researcher id again/
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), unresolved)
  await invoke(worker.tools, 'delegate_worker', swarm(['b', 'c']))
  await invoke(worker.tools, 'delegate_worker', { ...leaf, writePaths: [] })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), unresolved)
  await invoke(worker.tools, 'delegate_worker', swarm(['a']))
  await invoke(worker.tools, 'submit_result', pass)

  // Each researcher sees only its own earlier findings, never a sibling's.
  assert.deepEqual(previous, {
    'a#1': [],
    'b#1': [],
    'b#2': ['b run 1'],
    'c#1': [],
    'leaf#1': [],
    'a#2': ['a is unresolved'],
  })
})

test('cancelling a swarm stops every researcher and records no receipt', async (t) => {
  const { request, controller } = await setup(t)
  const ids = ['one', 'two', 'three']
  const barrier = gate()
  const stopped: string[] = []
  let started = 0
  const worker = await createTaskCoordinatorTools(
    request,
    controller.signal,
    async (child, signal) => {
      const id = researcherOf(child)!
      assert.equal(signal, controller.signal)

      if (++started === ids.length) {
        barrier.open()
      }

      if (id === 'one') {
        return receipt(child)
      }

      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          stopped.push(id)
          reject(signal!.reason)
        })
      })
    },
  )
  const research = invoke(worker.tools, 'delegate_worker', swarm(ids))
  await barrier.opened

  // Researcher one finishes on its own; a cancelled swarm still records nothing for it.
  await advance(request.workspace)
  controller.abort(new Error('fixture cancellation'))
  await assert.rejects(research, /fixture cancellation/)
  assert.deepEqual(stopped, ['two', 'three'])
  assert.equal(worker.children().length, 0)
  await assert.rejects(readFile(`${request.outputPath}.children.json`), { code: 'ENOENT' })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /fixture cancellation/)
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', swarm(['late'])),
    /fixture cancellation/,
  )
  assert.equal(started, ids.length)
})

test('a swarm rejects writers, measurements and duplicate ids before dispatch', async (t) => {
  const { request, controller } = await setup(t)
  const sent: unknown[] = []
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    sent.push([researcherOf(child), child.thinking])
    return receipt(child)
  })
  const one = (researcher: object) => ({ ...swarm([]), researchers: [researcher] })
  const rejected: [unknown, RegExp][] = [
    [{ ...swarm(['a', 'b']), writePaths: ['src/**'] }, /read-only/],
    [swarm(['a', 'b'], 'performance'), /measurement runs alone/],
    [swarm(['a', 'b', 'a']), /unique within a swarm: a/],
    [swarm(['Not An Id']), /Invalid leaf/],
    [swarm([]), /Invalid leaf/],
    [one({ id: 'a', task: 'Read', writePaths: ['src/**'] }), /Invalid leaf/],
    [one({ id: 'a', task: 'Read', thinking: 'xhigh' }), /Invalid leaf/],
    [one({ id: 'a' }), /Invalid leaf/],
  ]

  for (const [args, expected] of rejected) {
    await assert.rejects(invoke(worker.tools, 'delegate_worker', args), expected)
  }

  assert.deepEqual(sent, [])

  // A rejected request starts nothing and leaves the candidate valid.
  await invoke(worker.tools, 'delegate_worker', {
    ...swarm([]),
    thinking: 'high',
    researchers: [
      { id: 'a', task: 'Read the entry point', thinking: 'low' },
      { id: 'b', task: 'Read the tests' },
    ],
  })
  assert.deepEqual(sent, [
    ['a', 'low'],
    ['b', 'high'],
  ])
  await invoke(worker.tools, 'submit_result', pass)
})

test('an edit during a read-only swarm invalidates the candidate', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    if (researcherOf(child) === 'editor') {
      await writeFile(join(request.workspace, 'src/value.js'), 'unauthorized\n')
    }

    return receipt(child)
  })
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', swarm(['reader', 'editor'])),
    /Read-only research swarm changed the candidate: src\/value\.js/,
  )
  assert.equal(worker.children().length, 0)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
  await invoke(worker.tools, 'submit_result', { ...pass, verdict: 'blocked' })
  assert.equal(worker.result()?.verdict, 'blocked')
})

test('a quota rejection is a capacity failure that later swarms do not relaunch', async (t) => {
  const { request, controller } = await setup(t)
  const retryAt = Date.now() + 86400000
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    dispatched++

    if (researcherOf(child) === 'limited' && dispatched <= 2) {
      throw new ProviderQuotaError('Research quota exhausted', retryAt)
    }

    return receipt(child)
  })
  const first = report(await invoke(worker.tools, 'delegate_worker', swarm(['free', 'limited'])))
  assert.deepEqual(first.researchers[1], {
    id: 'limited',
    status: 'failed',
    capacity: true,
    error: 'Error: Research quota exhausted',
    retryAt,
  })
  assert.equal(dispatched, 2)
  const second = report(await invoke(worker.tools, 'delegate_worker', swarm(['limited'])))
  assert.equal(second.swarm.capacityFailures, 1)
  assert.equal(dispatched, 2)
  worker.invalidateResult()
  const third = report(await invoke(worker.tools, 'delegate_worker', swarm(['limited'])))
  assert.deepEqual(third.unfinished, [])
  assert.equal(dispatched, 3)
})

test('swarm progress follows a researcher that is still running', async (t) => {
  const { request, controller } = await setup(t)
  const gates = { fast: gate(), slow: gate() }
  const reported = gate()
  let reports = 0
  const worker = await createTaskCoordinatorTools(
    request,
    controller.signal,
    async (child, _signal, progress) => {
      const id = researcherOf(child) as keyof typeof gates
      await progress?.({
        stage: 'tool',
        role: child.role,
        tool: `${id}-tool`,
        updatedAt: new Date().toISOString(),
      })

      if (++reports === 2) {
        reported.open()
      }

      await gates[id].opened
      return receipt(child)
    },
  )
  const research = invoke(worker.tools, 'delegate_worker', swarm(['slow', 'fast']))
  await reported.opened
  gates.fast.open()
  let running = await readProgress(request.outputPath)

  for (let trip = 0; trip < 5000 && !running?.message?.includes('1 of 2 settled'); trip++) {
    running = await readProgress(request.outputPath)
  }

  // Both share a role. The parent points at the one still running, not the one that finished.
  assert.equal(running?.message, 'Research swarm: 1 of 2 settled')
  assert.equal(running?.stage, 'child')
  assert.equal(running?.child?.tool, 'slow-tool')
  gates.slow.open()
  await research
  await worker.progress.settle()
  const done = await readProgress(request.outputPath)
  assert.equal(done?.stage, 'coordinating')
  assert.equal(done?.message, 'Research swarm: 2 of 2 completed')
  assert.equal(done?.child, undefined)
})

test('workflow progress keeps same-role siblings distinct', async (t) => {
  const { request } = await setup(t)
  const gates = [gate(), gate()]
  const reported = gate()
  let calls = 0
  let reports = 0
  const dispatch = trackDispatch(async (child, _signal, progress) => {
    const index = calls++
    await progress?.({
      stage: 'tool',
      role: child.role,
      tool: `tool-${index}`,
      updatedAt: new Date().toISOString(),
    })

    if (++reports === 2) {
      reported.open()
    }

    await gates[index]!.opened
    return receipt(child)
  }, request.outputPath)
  const child = {
    role: 'task-worker' as const,
    task: 'Read one area',
    workspace: request.workspace,
    project: request.project,
    checkpoint: request.checkpoint,
    model: request.model,
    baseline: request.baseline,
  }
  const first = dispatch(child)
  const second = dispatch(child)
  await reported.opened
  gates[1]!.open()
  await second

  // Keyed by role, the finished sibling erased the running one and the parent looked idle.
  const running = await readProgress(request.outputPath)
  assert.equal(running?.stage, 'child')
  assert.equal(running?.child?.tool, 'tool-0')
  gates[0]!.open()
  await first
  assert.equal((await readProgress(request.outputPath))?.stage, 'checking')
})
