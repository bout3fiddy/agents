import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture, evidence } from './support.ts'
import { captureSession } from './session-support.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { Delegations, delegationDirectory } from '../src/delegation-state.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { progressReporter, trackDispatch } from '../src/progress.ts'
import { runWorkflow } from '../src/workflow.ts'

test('periodic progress reaches an idle orchestrator without a new model turn', async () => {
  const item = await fixture()
  let requests = 0
  let observed = false
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [
      (pi) => {
        registerDelegation(pi)
      },
    ],
    async (context) => {
      requests++
      const text = JSON.stringify(context.messages)
      observed =
        text.includes('Applying a focused edit') &&
        text.includes('Recovery decisions are documented')
      return [{ type: 'text', text: 'Discussion continues with current worker progress.' }]
    },
  )

  try {
    const store = new StateStore(item.root)
    const jobs = new Delegations(store)
    const job = await jobs.start(
      { task: 'Update the design', context: '', kind: 'documents', writePaths: ['design.md'] },
      { session: session.sessionManager.getSessionId(), model: 'capture/capture' },
      async () => {},
    )
    const directory = delegationDirectory(store, job.request.id)
    await atomicJson(join(directory, 'request.json'), {
      ...job.request,
      createdAt: new Date(Date.now() - 61000).toISOString(),
    })
    await atomicJson(join(directory, 'status.json'), {
      ...job.state,
      status: 'running',
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    })
    await progressReporter(join(directory, 'coordinator.json')).update({
      stage: 'child',
      role: 'task-worker',
      message: 'Applying a focused edit',
      child: {
        stage: 'tool',
        role: 'task-worker',
        tool: 'project_edit',
        updatedAt: new Date().toISOString(),
      },
    })
    await atomicJson(join(directory, 'coordinator.json.summary.json'), {
      summary: 'Recovery decisions are documented',
      updatedAt: new Date().toISOString(),
    })
    const notices = () =>
      session.sessionManager
        .getEntries()
        .filter(
          (entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-progress',
        )

    for (let attempt = 0; attempt < 60 && !notices().length; attempt++) {
      await delay(50)
    }

    assert.equal(notices().length, 1)
    const notice = notices()[0]
    assert.equal(notice?.type === 'custom_message' && notice.display, false)
    assert.equal(requests, 0, 'Routine progress must not interrupt or wake the model')
    assert.equal((await jobs.get(job.request.id)).state.progress?.child?.tool, 'project_edit')
    await session.prompt('Continue discussing the next choice.')
    assert.equal(requests, 1)
    assert.equal(observed, true)
    await session.reload()
    await delay(1200)
    assert.equal(notices().length, 1)
    assert.equal(requests, 1)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('accepted workflows expose active worker progress', async () => {
  const item = await fixture()

  try {
    const jobs = new Delegations(item.store)
    const job = await jobs.start(
      {
        task: 'Implement the accepted design',
        context: '',
        kind: 'implementation',
        writePaths: [],
      },
      { session: 'workflow-progress', model: 'fixture/model' },
      async () => {},
    )
    const output = join(delegationDirectory(item.store, job.request.id), 'coordinator.json')
    const roles: string[] = []
    const result = await runWorkflow(
      item.store,
      'fixture/model',
      undefined,
      trackDispatch(async (request, _signal, report) => {
        await report?.({
          stage: 'tool',
          role: request.role,
          tool: 'project_read',
          updatedAt: new Date().toISOString(),
        })
        const current = await jobs.get(job.request.id)
        assert.equal(current.state.progress?.child?.tool, 'project_read')
        assert.equal(current.state.progress?.child?.role, request.role)
        assert.equal(current.state.health, 'active')

        assert.equal(current.milestone, undefined)
        roles.push(request.role)
        return evidence(request)
      }, output),
    )
    assert.equal(result.status, 'complete', result.error)
    assert.deepEqual(roles, ['implementer'])
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('a silent task raises one attention notice without cancellation', async () => {
  const item = await fixture()
  let requests = 0
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [
      (pi) => {
        registerDelegation(pi)
      },
    ],
    async () => {
      requests++
      return [{ type: 'text', text: 'Inspect the retained trace before deciding on recovery.' }]
    },
  )

  try {
    const store = new StateStore(item.root)
    const jobs = new Delegations(store)
    const job = await jobs.start(
      { task: 'Investigate', context: '', kind: 'research', writePaths: [] },
      { session: session.sessionManager.getSessionId(), model: 'capture/capture' },
      async () => {},
    )
    const directory = delegationDirectory(store, job.request.id)
    await atomicJson(join(directory, 'status.json'), {
      ...job.state,
      status: 'running',
      pid: process.pid,
      updatedAt: new Date(Date.now() - 181000).toISOString(),
    })

    for (let attempt = 0; attempt < 60; attempt++) {
      if (requests) {
        break
      }

      await delay(50)
    }

    await session.waitForIdle()
    assert.equal(requests, 1)
    assert.equal((await jobs.get(job.request.id)).state.status, 'running')
    await delay(1200)
    assert.equal(requests, 1)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('milestones batch, survive reload and yield to final outcomes', async (t) => {
  const item = await fixture()
  const calls: string[] = []
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [
      (pi) => {
        registerDelegation(pi)
      },
    ],
    async (context) => {
      calls.push(JSON.stringify(context.messages))
      return [{ type: 'text', text: 'The recovery checkpoint is ready for the next dependency.' }]
    },
  )
  t.after(async () => {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  })
  const store = new StateStore(item.root)
  const jobs = new Delegations(store)
  const owner = { session: session.sessionManager.getSessionId(), model: 'capture/capture' }

  async function start(task: string) {
    const job = await jobs.start(
      { task, context: '', kind: 'research', writePaths: [] },
      owner,
      async () => {},
    )
    const directory = delegationDirectory(store, job.request.id)
    const state = { ...job.state, status: 'running', pid: process.pid }
    const setState = (change: object) =>
      atomicJson(join(directory, 'status.json'), { ...state, ...change })
    await setState({})
    return { setState, progress: progressReporter(join(directory, 'coordinator.json')) }
  }

  async function waitForCalls(count: number) {
    for (let attempt = 0; attempt < 80 && calls.length < count; attempt++) {
      await delay(50)
    }

    await session.waitForIdle()
    assert.equal(calls.length, count)
  }

  const notices = () =>
    session.sessionManager
      .getEntries()
      .filter(
        (entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-milestone',
      )
  const first = await start('Recovery')
  const second = await start('Independent integration')
  await first.progress.update({
    milestone: 'Restart test recovered every committed row.',
    child: {
      stage: 'model',
      updatedAt: new Date().toISOString(),
      requestedModel: 'claude-fable-5-2',
      actualModel: 'opus',
      fallbackReason: 'quota-cached',
      confirmedAt: Date.now(),
      retryAt: Date.now() + 60000,
    },
  })
  await second.setState({ status: 'merge_queued', commit: 'dc5b1af', branch: 'pi/integration' })
  await waitForCalls(1)
  assert.equal(notices().length, 1)
  const notice = notices()[0]
  assert.ok(notice?.type === 'custom_message' && !notice.display)
  assert.equal((notice.details as { taskIds: string[] }).taskIds.length, 3)
  assert.match(String(notice.content), /claude-fable-5-2 → opus \(quota-cached\)/)
  assert.match(calls[0]!, /Restart test recovered every committed row/)
  assert.match(calls[0]!, /Published pi\/integration at dc5b1af/)

  await first.progress.update({ stage: 'child', message: 'Reading another file.' })
  await session.reload()
  await delay(1200)
  assert.equal(calls.length, 1)

  await first.progress.update({ milestone: 'Replica catch-up verified under load.' })
  await delay(1200)
  assert.equal(calls.length, 1, 'Hold nearby updates to combine with other outcomes')
  await second.progress.update({ milestone: 'Obsolete integration update.' })
  await second.setState({ status: 'complete', summary: 'Integrated on main.' })
  await waitForCalls(2)
  assert.equal(notices().length, 2)
  assert.match(calls[1]!, /Replica catch-up verified under load/)
  assert.match(calls[1]!, /Integrated on main/)
  assert.doesNotMatch(calls[1]!, /Obsolete integration update/)
  const latest = notices().at(-1)
  assert.ok(latest?.type === 'custom_message')
  assert.doesNotMatch(String(latest.content), /Obsolete integration update|quota-cached/)
  await session.reload()
  await delay(1200)
  assert.equal(calls.length, 2)
})
