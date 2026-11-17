import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './support.ts'
import { StateStore, atomicJson, readJson } from '../src/state.ts'
import {
  Delegations,
  delegationDirectory,
  type Delegation,
  type TaskControls,
} from '../src/delegation-state.ts'
import { runDelegation } from '../src/delegation-runner.ts'
import { reviseTasks } from '../src/task-recovery.ts'
import type { TaskCoordinatorEvidence } from '../src/task-coordinator.ts'
import { captureSession } from './session-support.ts'
import { registerDelegation } from '../src/delegation-tools.ts'

const origin = { session: 'recovery-test', model: 'test/model' }
const signal = () => new AbortController().signal
const result = (revision = 0): TaskCoordinatorEvidence => ({
  model: 'test/model',
  turns: 1,
  children: [],
  controlRevision: revision,
  result: {
    verdict: 'pass',
    summary: 'Verified revised work',
    findings: [],
    databaseImpact: false,
    evidence: ['Retained edit inspected'],
  },
})
const assignment = (id: string, path: string) => ({
  id,
  task: `Complete ${path}`,
  context: 'Preserve retained edits; finish the revised assignment.',
  writePaths: [path],
})

async function paused(jobs: Delegations, path: string) {
  const job = await jobs.start(
    {
      task: `Edit ${path}`,
      context: 'Preserve other files',
      kind: 'documents',
      writePaths: [path],
    },
    origin,
    async () => {},
  )
  const state = await runDelegation(jobs.store, job.request.id, signal(), async (request) => {
    await writeFile(join(request.workspace, path), `# Retained ${path}\n`)
    await jobs.control(job.request.id, 'pause')
    return result()
  })
  assert.equal(state.status, 'paused', state.error)
  await assert.rejects(readFile(join(jobs.store.projectRoot, path)), { code: 'ENOENT' })
  return jobs.get(job.request.id)
}

async function cleanup(jobs: Delegations) {
  for (const job of await jobs.list()) {
    const workspace = await readJson<{ workspace: string; originals: string }>(
      join(delegationDirectory(jobs.store, job.request.id), 'workspace.json'),
    )

    for (const path of [workspace?.workspace, workspace?.originals, job.state.candidate]) {
      if (path) {
        await rm(path, { recursive: true, force: true })
      }
    }
  }
}

test('pause retains ownership and resume preserves candidate edits', async () => {
  const { base, store, root } = await fixture()
  const jobs = new Delegations(store)

  try {
    const job = await paused(jobs, 'decision.md')
    await assert.rejects(
      jobs.start(
        {
          task: 'Colliding task',
          context: '',
          kind: 'documents',
          writePaths: ['DECISION.md'],
        },
        origin,
        async () => {},
      ),
      /already owned/,
    )
    await jobs.control(job.request.id, 'message', 'Append the final decision.')
    let launched = false
    const resumed = await jobs.resume(job.request.id, origin, async () => {
      launched = true
    })
    assert.equal(launched, true)
    assert.equal(resumed.state.deliveryVersion, 1)
    const state = await runDelegation(store, job.request.id, signal(), async (request) => {
      assert.equal(request.workspace, job.state.candidate)
      assert.equal(request.resumed, true)
      assert.equal(
        await readFile(join(request.workspace, 'decision.md'), 'utf8'),
        '# Retained decision.md\n',
      )
      await writeFile(join(request.workspace, 'decision.md'), '# Retained decision.md\n\nFinal.\n')
      return result(1)
    })
    assert.equal(state.status, 'complete', state.error)
    assert.equal(
      await readFile(join(root, 'decision.md'), 'utf8'),
      '# Retained decision.md\n\nFinal.\n',
    )
  } finally {
    await cleanup(jobs)
    await rm(base, { recursive: true, force: true })
  }
})

test('batch reassignment transfers edits and clears stale approvals', async () => {
  const { base, store, root } = await fixture()
  const jobs = new Delegations(store)
  const originals: string[] = []

  try {
    const a = await paused(jobs, 'a.md')
    const b = await paused(jobs, 'b.md')
    originals.push(a.state.candidate!, b.state.candidate!)
    const revised = await reviseTasks(jobs, {
      tasks: [assignment(a.request.id, 'b.md'), assignment(b.request.id, 'a.md')],
    })
    assert.deepEqual(
      revised.map((job) => job.state.status),
      ['paused', 'paused'],
    )
    assert.deepEqual(
      revised.map((job) => job.state.receipts),
      [undefined, undefined],
    )

    for (const job of revised) {
      const path = job.request.writePaths[0]!
      assert.equal(await readFile(join(job.state.candidate!, path), 'utf8'), `# Retained ${path}\n`)
      const other = path === 'a.md' ? 'b.md' : 'a.md'
      await assert.rejects(readFile(join(job.state.candidate!, other)), { code: 'ENOENT' })
      await jobs.resume(job.request.id, origin, async () => {})
      const state = await runDelegation(store, job.request.id, signal(), async (request) => {
        assert.match(request.context, /revised assignment/)
        return result(1)
      })
      assert.equal(state.status, 'complete', state.error)
    }

    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# Retained a.md\n')
    assert.equal(await readFile(join(root, 'b.md'), 'utf8'), '# Retained b.md\n')
    assert.equal(await readFile(join(originals[0]!, 'a.md'), 'utf8'), '# Retained a.md\n')
    assert.equal(await readFile(join(originals[1]!, 'b.md'), 'utf8'), '# Retained b.md\n')
  } finally {
    await cleanup(jobs)
    await Promise.all(originals.map((path) => rm(path, { recursive: true, force: true })))
    await rm(base, { recursive: true, force: true })
  }
})

for (const failure of ['active', 'collision', 'expansion', 'unowned', 'concurrent', 'cancelled']) {
  test(`unsafe reassignment rejects ${failure}`, async () => {
    const { base, store, root } = await fixture()
    const jobs = new Delegations(store)

    try {
      const a = await paused(jobs, 'a.md')
      const b = await paused(jobs, 'b.md')
      const tasks = [assignment(a.request.id, 'a.md'), assignment(b.request.id, 'b.md')]
      let expected = /colliding/

      if (failure === 'active') {
        await jobs.resume(a.request.id, origin, async () => {})
        expected = /Pause every/
      } else if (failure === 'expansion') {
        tasks[0]!.writePaths = ['new.md']
        expected = /Scope expansion/
      } else if (failure === 'unowned') {
        await atomicJson(join(delegationDirectory(store, a.request.id), 'request.json'), {
          ...a.request,
          kind: 'maintenance',
        })
        tasks[0]!.writePaths = []
        expected = /no owner/
      } else if (failure === 'concurrent') {
        await writeFile(join(root, 'a.md'), '# User edit\n')
        expected = /Concurrent project edit/
      } else if (failure === 'cancelled') {
        await jobs.control(a.request.id, 'cancel')
        expected = /Pause every/
      } else {
        tasks[1]!.writePaths = ['a.md']
      }

      await assert.rejects(reviseTasks(jobs, { tasks }), expected)
      assert.equal((await jobs.get(a.request.id)).request.task, a.request.task)
      assert.equal((await jobs.get(b.request.id)).state.candidate, b.state.candidate)
    } finally {
      await cleanup(jobs)
      await rm(base, { recursive: true, force: true })
    }
  })
}

test('prepared revisions recover before another task can launch', async () => {
  const { base, store } = await fixture()
  const jobs = new Delegations(store)
  let old: Delegation | undefined

  try {
    old = await paused(jobs, 'a.md')
    const [revised] = await reviseTasks(jobs, { tasks: [assignment(old.request.id, 'a.md')] })
    const archives = join(store.directory, 'delegations', 'revisions')
    const journal = await readJson(join(archives, (await readdir(archives))[0]!))
    const directory = delegationDirectory(store, old.request.id)
    await atomicJson(join(directory, 'request.json'), old.request)
    await atomicJson(join(directory, 'status.json'), old.state)
    await atomicJson(join(store.directory, 'delegations', 'pending-revision.json'), journal)
    await jobs.resume(old.request.id, origin, async (request) => {
      assert.equal(request.task, revised!.request.task)
      assert.equal((await jobs.get(request.id)).state.candidate, revised!.state.candidate)
    })
    await assert.rejects(readFile(join(store.directory, 'delegations', 'pending-revision.json')), {
      code: 'ENOENT',
    })
  } finally {
    await cleanup(jobs)

    if (old?.state.candidate) {
      await rm(old.state.candidate, { recursive: true, force: true })
    }

    await rm(base, { recursive: true, force: true })
  }
})

test('real SDK exposes pause and revision tools and guards paused files', async () => {
  const { base, root } = await fixture()
  const jobs = new Delegations(new StateStore(root))
  const job = await paused(jobs, 'decision.md')
  let step = 0
  const captured = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerDelegation(pi)
      },
    ],
    async () => {
      if (step++ === 0) {
        return [
          {
            type: 'toolCall',
            id: 'edit-owned',
            name: 'write',
            arguments: { path: 'decision.md', content: '# Overwritten\n' },
          },
        ]
      }

      if (step === 2) {
        return [
          {
            type: 'toolCall',
            id: 'revise',
            name: 'revise_tasks',
            arguments: { tasks: [assignment(job.request.id, 'decision.md')] },
          },
        ]
      }

      return [{ type: 'text', text: 'The worker is paused; the discussion can continue.' }]
    },
  )

  try {
    assert.ok(captured.session.getAllTools().some((tool) => tool.name === 'resume_task'))
    await captured.session.prompt('Inspect and revise the paused task; keep it paused.')
    await assert.rejects(readFile(join(root, 'decision.md')), { code: 'ENOENT' })
    const errors = captured.session.state.messages.filter(
      (message) => message.role === 'toolResult' && message.isError,
    )
    assert.equal(errors.length, 1)
    assert.equal((await jobs.get(job.request.id)).state.status, 'paused')
    const controls = await readJson<TaskControls>(
      join(delegationDirectory(jobs.store, job.request.id), 'controls.json'),
    )
    assert.equal(controls?.revision, 1)
  } finally {
    captured.session.dispose()
    await captured.runtime.settleCredentialWrites()
    await cleanup(jobs)
    await rm(job.state.candidate!, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})
