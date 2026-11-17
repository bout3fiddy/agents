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
      observed = JSON.stringify(context.messages).includes('Applying a focused edit')
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
        roles.push(request.role)
        return evidence(request)
      }, output),
    )
    assert.equal(result.status, 'complete', result.error)
    assert.deepEqual(roles, ['implementer', 'reviewer'])
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
