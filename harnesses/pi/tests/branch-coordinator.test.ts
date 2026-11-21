import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { WorkerResult } from '../src/contracts.ts'
import type { Dispatcher } from '../src/dispatch.ts'
import { loadRole } from '../src/roles.ts'
import { createWorkerTools } from '../src/worker-tools.ts'
import { createWorkspace, loadProject } from '../src/project.ts'
import { createTaskCoordinatorTools, type TaskCoordinatorRequest } from '../src/task-coordinator.ts'
import { evidence, fixture, hashes } from './support.ts'

const pass: WorkerResult = {
  verdict: 'pass',
  summary: 'All branch acceptance gates passed',
  findings: [],
  databaseImpact: false,
  evidence: ['Behavioral counter assertion passed'],
}

function invoke(tools: ToolDefinition[], name: string, args: unknown = {}) {
  const tool = tools.find((item) => item.name === name)!
  return tool.execute(
    'branch-fixture',
    args,
    undefined,
    undefined,
    {} as Parameters<ToolDefinition['execute']>[4],
  )
}

function assignment(role: string, writePaths: string[] = []) {
  return { role, task: 'Apply the authorized design and resolve reported findings.', writePaths }
}

async function receipt(request: Parameters<Dispatcher>[0], result: Partial<WorkerResult> = {}) {
  const role = await loadRole(request.role)
  return {
    ...(await evidence(request, result)),
    model: role.backend === 'claude-cli' ? `claude-cli/${role.model}` : role.model,
  }
}

async function setup(t: TestContext, options: { database?: boolean; performance?: boolean } = {}) {
  const { base, root, store } = await fixture(options)
  const originals = await createWorkspace(root)
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    await rm(originals, { recursive: true, force: true })
  })
  const request: TaskCoordinatorRequest = {
    task: 'Implement the documented value semantics autonomously',
    context: 'docs/design.md: value must equal seven. Parent supplied all decisions.',
    kind: 'branch',
    workspace: root,
    project: await loadProject(root),
    checkpoint: (await store.checkpoint())!,
    model: 'openai-codex/gpt-6.1-sol',
    outputPath: join(root, '.pi/traces/task/result.json'),
    baseline: await hashes(root),
    originals,
  }
  return { request, signal: new AbortController().signal }
}

test('run_checks distinguishes inherited lint from a changed failing file', async (t) => {
  const { request, signal } = await setup(t)
  const name = 'existing.js'
  const longLine = '// ' + 'x'.repeat(110) + '\n'
  await writeFile(join(request.workspace, name), longLine)
  await writeFile(join(request.originals, name), longLine)
  request.baseline = await hashes(request.workspace)
  const worker = await createTaskCoordinatorTools(request, signal, (child) => receipt(child))

  async function lint() {
    const result = await invoke(worker.tools, 'run_checks')
    const text = result.content[0]
    assert.ok(text?.type === 'text')
    return JSON.parse(text.text).checks[0]
  }

  const inherited = await lint()
  assert.equal(inherited.status, 'failed')
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', {
      ...assignment('reviewer'),
      bugCheck: 'harness-lint',
    }),
    /Invalid leaf assignment/,
  )
  assert.deepEqual(inherited.inheritedLintPaths, [name])
  await writeFile(join(request.workspace, name), longLine + '// changed\n')
  const changed = await lint()
  assert.equal(changed.status, 'failed')
  assert.equal(changed.inheritedLintPaths, undefined)
})

test('a failing branch sends the regression to the implementer without review', async (t) => {
  const { request, signal } = await setup(t)
  request.project.checks[0]!.argv = [
    'node',
    '-e',
    'import("./src/value.js").then(m => require("node:assert/strict").equal(m.value, 7))',
  ]
  const roles: string[] = []
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    roles.push(child.role)

    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    return receipt(child)
  })
  const diagnose = () =>
    invoke(worker.tools, 'delegate_worker', {
      ...assignment('reviewer'),
      bugCheck: 'contract',
    })
  await assert.rejects(diagnose(), /Invalid leaf assignment/)
  await invoke(worker.tools, 'run_checks')
  assert.equal(worker.checks().find((check) => check.check === 'contract')?.status, 'failed')
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await assert.rejects(diagnose(), /Invalid leaf assignment/)
  await invoke(worker.tools, 'delegate_worker', assignment('implementer', ['src/**']))
  await assert.rejects(diagnose(), /Invalid leaf assignment/)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass))
  await invoke(worker.tools, 'run_checks')
  await assert.rejects(diagnose(), /Invalid leaf assignment/)
  await invoke(worker.tools, 'submit_result', pass)
  assert.deepEqual(roles, ['implementer'])
})

test('green code passes lint, tests, recovery and benchmarks without review', async (t) => {
  const { request, signal } = await setup(t, { database: true, performance: true })
  Object.assign(request.checkpoint, { review: true }) // Older pending branch.
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    assert.equal(child.role, 'implementer')
    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    return receipt(child)
  })
  await invoke(worker.tools, 'delegate_worker', assignment('implementer', ['src/**']))
  await invoke(worker.tools, 'run_checks')

  for (const check of ['contract', 'recovery', 'latency', 'harness-lint']) {
    assert.equal(worker.checks().find((item) => item.check === check)?.status, 'passed')
  }

  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('reviewer')),
    /Invalid leaf assignment/,
  )
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('performance')),
    /explicit/,
  )
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.children().length, 1)
})

test('explicit performance request dispatches the performance specialist', async (t) => {
  const { request, signal } = await setup(t, { performance: true })
  request.checkpoint.performanceReview = true
  const worker = await createTaskCoordinatorTools(request, signal, (child) => receipt(child))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /performance/)
  await invoke(worker.tools, 'delegate_worker', assignment('performance', ['benchmarks/**']))
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
})

test('newly detected database changes invalidate checks lacking recovery coverage', async (t) => {
  const { request, signal } = await setup(t, { database: true })
  request.checkpoint.database = false
  let database = false
  const worker = await createTaskCoordinatorTools(request, signal, (child) =>
    receipt(child, { databaseImpact: database }),
  )
  await invoke(worker.tools, 'run_checks')
  database = true
  await invoke(worker.tools, 'delegate_worker', assignment('implementer'))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
})

test('branch document scopes reject misrouted manifests before any write', async (t) => {
  const { request, signal } = await setup(t)
  const manifest = 'src/artifact.receipt.json'
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    dispatched++

    if (child.role === 'task-worker') {
      const role = await loadRole(child.role)
      const leaf = createWorkerTools({ ...child, outputPath: request.outputPath }, role)

      for (const [tool, args] of [
        ['project_write', { path: manifest, content: '{}' }],
        ['project_edit', { path: manifest, oldText: '{}', newText: '[]' }],
        ['project_delete', { path: manifest }],
        ['project_format', { paths: [manifest] }],
      ] as const) {
        await assert.rejects(invoke(leaf.tools, tool, args), /outside/)
      }

      await invoke(leaf.tools, 'project_write', { path: 'src/note.md', content: '# Note\n' })
    }

    if (child.role === 'implementer') {
      await writeFile(join(request.workspace, manifest), '{}\n')
    }

    return receipt(child)
  })
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('task-worker', [manifest])),
    /implementer/,
  )
  assert.equal(dispatched, 0)
  await invoke(worker.tools, 'delegate_worker', assignment('task-worker', ['src/**']))
  await invoke(worker.tools, 'delegate_worker', assignment('implementer', [manifest]))
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('branch edits cannot use a general task worker to bypass the implementer', async (t) => {
  const { request, signal } = await setup(t)
  let dispatched = 0
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    dispatched++
    await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    return receipt(child)
  })
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('task-worker', ['src/**'])),
    /requires the implementer/,
  )
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('implementer')),
    /requires the implementer.*Submit blocked/,
  )
  await assert.rejects(invoke(worker.tools, 'run_checks'), /Submit blocked/)
  assert.equal(dispatched, 1)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /failed child execution/)
  await invoke(worker.tools, 'submit_result', { ...pass, verdict: 'blocked' })
  assert.equal(worker.result()?.verdict, 'blocked')
})

test('coordinator-reported database impact also requires fresh recovery evidence', async (t) => {
  const { request, signal } = await setup(t, { database: true })
  request.checkpoint.database = false
  const worker = await createTaskCoordinatorTools(request, signal, (child) => receipt(child))
  await invoke(worker.tools, 'run_checks')
  await assert.rejects(
    invoke(worker.tools, 'submit_result', { ...pass, databaseImpact: true }),
    /run_checks/,
  )
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
})

test('branch coordination continues beyond the old child-call ceiling', async (t) => {
  const { request, signal } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, signal, (child) => receipt(child))

  for (let call = 0; call < 30; call++) {
    await invoke(worker.tools, 'delegate_worker', assignment('task-worker'))
  }

  assert.equal(worker.children().length, 30)
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
  const role = await loadRole('branch-orchestrator')
  assert.equal(role.mayDelegate, true)
  assert.equal('maxTurns' in role, false)
  assert.equal('timeoutMs' in role, false)
  assert.ok(role.tools.includes('run_checks'))
})
