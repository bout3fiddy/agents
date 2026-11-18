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

test('branch coordinator repairs failing checks and refreshes review before passing', async (t) => {
  const { request, signal } = await setup(t)
  request.project.checks[0]!.argv = [
    'node',
    '-e',
    'import("./src/value.js").then(m => require("node:assert/strict").equal(m.value, 7))',
  ]
  let implementationCalls = 0
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    assert.match(child.task, /Authorized design-document implementation/)
    assert.deepEqual(child.changedFiles, implementationCalls ? ['src/value.js'] : [])

    if (child.role === 'implementer') {
      implementationCalls++
      await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    }

    return receipt(child)
  })
  assert.equal(
    worker.tools.some((tool) => tool.name === 'project_write'),
    false,
  )
  assert.equal(
    worker.tools.some((tool) => tool.name === 'delegate_task'),
    false,
  )
  await invoke(worker.tools, 'run_checks')
  assert.equal(worker.checks().find((check) => check.check === 'contract')?.status, 'failed')
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'delegate_worker', assignment('implementer', ['src/**']))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /refresh requested reviews/)
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'run_checks')
  assert.ok(worker.checks().every((check) => check.status === 'passed'))
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(implementationCalls, 1)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('branch coordinator consumes reviewer findings through repair and fresh review', async (t) => {
  const { request, signal } = await setup(t)
  let reviewCalls = 0
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    if (child.role === 'reviewer') {
      reviewCalls++

      if (reviewCalls === 1) {
        return receipt(child, {
          verdict: 'changes',
          findings: [
            {
              severity: 'required',
              location: 'src/value.js',
              problem: 'The documented value is seven.',
              evidence: 'The export is zero.',
            },
          ],
        })
      }

      assert.match(child.task, /The documented value is seven/)
    }

    if (child.role === 'implementer') {
      await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 7\n')
    }

    return receipt(child)
  })
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /Resolve child findings/)
  await invoke(worker.tools, 'delegate_worker', assignment('implementer', ['src/**']))
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await invoke(worker.tools, 'submit_result', pass)
  assert.equal(worker.result()?.verdict, 'pass')
})

test('branch completion requires database and performance evidence when scoped', async (t) => {
  const { request, signal } = await setup(t, { database: true, performance: true })
  const worker = await createTaskCoordinatorTools(request, signal, (child) => {
    if (child.role === 'reviewer' || child.role === 'database-reviewer') {
      assert.equal(child.thinking, child.role === 'reviewer' ? 'medium' : 'high')
    }

    return receipt(child)
  })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /passing reviewer/)
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', assignment('reviewer')),
    /delegate_reviews/,
  )
  await invoke(worker.tools, 'delegate_reviews', {
    engineering: 'Verify the implementation.',
    database: 'Verify recovery.',
    engineeringThinking: 'medium',
    databaseThinking: 'high',
  })
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /performance/)
  await invoke(worker.tools, 'delegate_worker', assignment('performance', ['benchmarks/**']))
  await invoke(worker.tools, 'run_checks')
  assert.equal(worker.checks().find((check) => check.check === 'recovery')?.status, 'passed')
  assert.equal(worker.checks().find((check) => check.check === 'latency')?.status, 'passed')
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
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await invoke(worker.tools, 'delegate_worker', assignment('database-reviewer'))
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
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
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
    invoke(worker.tools, 'delegate_worker', assignment('reviewer')),
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
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  await assert.rejects(
    invoke(worker.tools, 'submit_result', { ...pass, databaseImpact: true }),
    /database-reviewer/,
  )
  await invoke(worker.tools, 'delegate_worker', assignment('database-reviewer'))
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'submit_result', pass)
})

test('branch coordination continues beyond the old child-call ceiling', async (t) => {
  const { request, signal } = await setup(t)
  const worker = await createTaskCoordinatorTools(request, signal, (child) => receipt(child))

  for (let call = 0; call < 30; call++) {
    await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
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

test('formatter repair closes branch review and preserves final checks', async (t) => {
  const { request, signal } = await setup(t)
  const path = 'src/guide.md'
  const original = '# Guide\n\n```ts\nsubmit(work);\n```\n'
  await writeFile(join(request.workspace, path), original)
  let reviews = 0
  const worker = await createTaskCoordinatorTools(request, signal, async (child) => {
    if (child.role === 'reviewer' && ++reviews === 1) {
      return receipt(child, {
        verdict: 'changes',
        findings: [
          {
            severity: 'required',
            location: path + ':4',
            problem: 'Format the example.',
            evidence: 'Pinned formatter removes the trailing semicolon.',
            formatterPath: path,
          },
        ],
      })
    }

    if (child.role === 'task-worker') {
      await writeFile(join(child.workspace, path), original.replace('work);', 'work)'))
    }

    return receipt(child)
  })
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  const repair = await invoke(worker.tools, 'delegate_worker', assignment('task-worker', [path]))
  assert.match(JSON.stringify(repair), /closedReviews/)
  await invoke(worker.tools, 'delegate_worker', assignment('reviewer'))
  assert.equal(reviews, 1)
  assert.equal(worker.children().filter((child) => child.closedReview).length, 1)
  await assert.rejects(invoke(worker.tools, 'submit_result', pass), /run_checks/)
  await invoke(worker.tools, 'run_checks')
  await invoke(worker.tools, 'delegate_worker', {
    ...assignment('reviewer'),
    freshReviewReason: 'Investigate a newly reported failure.',
  })
  assert.equal(reviews, 2)
  await invoke(worker.tools, 'submit_result', pass)
})
