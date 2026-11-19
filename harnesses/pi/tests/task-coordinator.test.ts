import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ProviderQuotaError, type WorkerResult } from '../src/contracts.ts'
import type { Dispatcher } from '../src/dispatch.ts'
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
import { readProgress } from '../src/progress.ts'
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
    /empty write scope/,
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
  const report = checked.content[0]
  assert.ok(report?.type === 'text')
  assert.equal(JSON.parse(report.text).status, 'passed')

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

test('completed Claude review survives 46 turns without duplication', async (t) => {
  const { request, controller } = await setup(t)
  let reviews = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    reviews++
    return { ...(await receipt(child)), turns: 46 }
  })
  await invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'reviewer', writePaths: [] })
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

test('reviewers and performance workers retain their enforced write restrictions', async (t) => {
  for (const role of ['reviewer', 'performance']) {
    const { request, controller } = await setup(t)
    const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
      await writeFile(join(request.workspace, 'src/value.js'), 'unauthorized\n')
      return receipt(child)
    })
    await assert.rejects(
      invoke(worker.tools, 'delegate_worker', {
        ...leaf,
        role,
        writePaths: role === 'reviewer' ? [] : ['src/**'],
      }),
      /outside its role or assignment/,
    )
    await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
  }
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

test('completion identifies unresolved scope and reuses unchanged reviews', async (t) => {
  const { request, controller } = await setup(t)
  let calls = 0
  let reviews = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    calls++
    reviews += Number(child.role === 'reviewer')
    return receipt(child, calls === 1 ? { verdict: 'blocked' } : {})
  })
  await invoke(worker.tools, 'delegate_worker', leaf)
  await invoke(worker.tools, 'delegate_worker', { ...leaf, role: 'reviewer', writePaths: [] })
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
  assert.equal(reviews, 1)
})

test('an edit invalidates an earlier requested engineering review', async (t) => {
  const { request, controller } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    if (child.role === 'task-worker') {
      await writeFile(join(request.workspace, 'src/value.js'), 'changed after review\n')
    }

    return receipt(child)
  })
  const review = { ...leaf, role: 'reviewer', writePaths: [] }
  await invoke(worker.tools, 'delegate_worker', review)
  await invoke(worker.tools, 'delegate_worker', leaf)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /refresh requested reviews/)
  await invoke(worker.tools, 'delegate_worker', review)
  await invoke(worker.tools, 'submit_result', pass)
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

const pairTasks = { engineering: 'Review correctness', database: 'Review recovery' }

test('paired verdicts overlap and hold repairs until both settle', { timeout: 5000 }, async (t) => {
  const { request, controller } = await setup(t)
  let start!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    start = resolve
  })
  let release!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Set<string>()
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    started.add(child.role)

    if (started.size === 2) {
      start()
    }

    if (child.role === 'database-reviewer') {
      await slow
    }

    return receipt(child, { summary: child.role, verdict: 'changes' })
  })
  const pair = invoke(worker.tools, 'delegate_reviews', pairTasks)
  await bothStarted

  try {
    assert.equal(worker.children().length, 0)
    await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /both review verdicts/)
    await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Wait for all/)
  } finally {
    release()
  }

  const result = await pair
  assert.match(JSON.stringify(result.content), /database-reviewer/)
  const children = worker.children()
  assert.deepEqual(
    children.map((c) => c.role),
    ['reviewer', 'database-reviewer'],
  )
  assert.equal(children[0]!.snapshot, children[1]!.snapshot)
  assert.deepEqual(
    JSON.parse(await readFile(request.outputPath + '.children.json', 'utf8')).map(
      (item: { evidence: unknown }) => item.evidence,
    ),
    children,
  )
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Resolve child findings/)
})

test('a failed paired dispatch retains its sibling and fences fixes until retry', async (t) => {
  const { request, controller } = await setup(t)
  let fail = true
  const calls: string[] = []
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    calls.push(child.role)

    if (child.role === 'database-reviewer' && fail) {
      throw new Error('DB reviewer unavailable')
    }

    return receipt(child)
  })
  await assert.rejects(invoke(worker.tools, 'delegate_reviews', pairTasks), /unavailable/)
  assert.deepEqual(
    worker.children().map((c) => c.role),
    ['reviewer'],
  )
  await assert.rejects(invoke(worker.tools, 'delegate_worker', leaf), /outstanding review/)
  await assert.rejects(invoke(worker.tools, 'delegate_reviews', pairTasks), /outstanding review/)
  fail = false
  const retry = await invoke(worker.tools, 'delegate_worker', {
    role: 'database-reviewer',
    task: 'Retry',
    writePaths: [],
  })
  const resultText = retry.content[0]!
  assert.equal(resultText.type, 'text')
  assert.deepEqual(
    JSON.parse(resultText.text).map((e: { role: string }) => e.role),
    ['reviewer', 'database-reviewer'],
  )
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(calls.filter((r) => r === 'reviewer').length, 1)
  assert.equal(calls.filter((r) => r === 'database-reviewer').length, 2)
})

test('coordinator selects effort per child and rejects invalid levels', async (t) => {
  const { request, controller } = await setup(t)
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
  await assert.rejects(run('reviewer', 'low'), /Unsupported thinking/)
  await assert.rejects(run('implementer', 'xhigh'), /Invalid leaf assignment/)
  await assert.rejects(run('database-reviewer', 'low'), /Unsupported thinking/)
  assert.deepEqual(sent, [])
  await run('task-worker', 'low')
  await run('implementer', 'high')
  await run('reviewer', 'medium')
  await run('reviewer')
  assert.deepEqual(sent, [
    ['task-worker', 'low'],
    ['implementer', 'high'],
    ['reviewer', 'medium'],
    ['reviewer', undefined],
  ])
})

test('hard quota rejection skips repeat review launches until new host guidance', async (t) => {
  const { request, controller } = await setup(t)
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, controller.signal, async (child) => {
    dispatched++

    if (dispatched === 1) {
      throw new ProviderQuotaError('Reviewer quota exhausted', Date.now() + 86400000)
    }

    return receipt(child)
  })
  const review = { role: 'reviewer', task: 'Review the candidate', writePaths: [] }
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
