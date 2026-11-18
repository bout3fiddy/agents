import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startBranchBatch, registerBranchTools } from '../src/branch-tools.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { activeTask, type DelegationStatus } from '../src/delegation-state.ts'
import { runBranchTask } from '../src/branch-runner.ts'
import { gitCommand, resolveRemote } from '../src/git-branches.ts'
import { loadProject } from '../src/project.ts'
import { captureSession } from './session-support.ts'
import { branchRepository, coordinatorEvidence, writeFeature } from './branch-support.ts'

test('a modified local design is rejected before any autonomous task is launched', async (t) => {
  const setup = await branchRepository(t)
  await writeFile(join(setup.root, 'docs/design.md'), '# Uncommitted replacement\n')
  let launches = 0
  await assert.rejects(
    startBranchBatch(setup.ctx, setup.input, undefined, async () => {
      launches++
    }),
    /matches the document on remote main/,
  )
  assert.equal(launches, 0)
  assert.deepEqual(await setup.jobs.list(), [])
})

test('independent branch fanout rejects intersecting scopes before launching', async (t) => {
  const setup = await branchRepository(t)
  let launches = 0
  await assert.rejects(
    startBranchBatch(
      setup.ctx,
      {
        ...setup.input,
        tasks: [setup.input.tasks[0]!, { ...setup.input.tasks[1]!, writePaths: ['src/**'] }],
      },
      undefined,
      async () => {
        launches++
      },
    ),
    /disjoint write scopes/,
  )
  assert.equal(launches, 0)
})

test('a filename wildcard rejects the whole batch before dispatch', async (t) => {
  const setup = await branchRepository(t)
  const invalid = {
    ...setup.input.tasks[1]!,
    writePaths: ['runtime/local/**', 'runtime/test/local_*.test.ts'],
  }
  let launches = 0
  await assert.rejects(
    startBranchBatch(
      setup.ctx,
      { ...setup.input, tasks: [setup.input.tasks[0]!, invalid] },
      undefined,
      async () => {
        launches++
      },
    ),
    /local_\*\.test\.ts.*exact/i,
  )
  assert.equal(launches, 0)
  assert.deepEqual(await setup.jobs.list(), [])
})

test('fanout discovers checks at the pinned commit before registering any tasks', async (t) => {
  const setup = await branchRepository(t)
  const git = (args: string[]) => gitCommand(setup.root, args)
  await git(['rm', '.pi/harness.json'])
  const scripts = { check: 'node --test', 'test:scaffold': 'node --test' }
  const manifest = join(setup.root, 'package.json')
  await writeFile(manifest, JSON.stringify({ scripts }))
  await git(['add', 'package.json'])
  await git(['commit', '-m', 'Use executable project scripts'])
  await git(['push', 'origin', 'HEAD:main'])
  await writeFile(
    manifest,
    JSON.stringify({ scripts: { ...scripts, 'test:recovery': 'node --test' } }),
  )
  const storage = { ...setup.input.tasks[1]!, database: true }
  await assert.rejects(
    setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!, storage] }),
    /Missing required database check on pinned main/,
  )
  assert.deepEqual(await setup.jobs.list(), [])
  assert.equal((await git(['worktree', 'list', '--porcelain'])).split('worktree ').length, 2)
  await writeFile(manifest, JSON.stringify({ scripts: { check: 'node --test' } }))
  assert.deepEqual((await loadProject(setup.root)).checks, [], 'check alone is not a test receipt')
  const { requests } = await setup.launch()
  assert.equal(requests.length, 2, 'Committed scaffold tests qualify both ordinary tasks')
  await writeFile(
    manifest,
    JSON.stringify({
      scripts: { ...scripts, test: 'node --test', 'test:recovery': 'node --test' },
    }),
  )
  const project = await loadProject(setup.root)
  assert.deepEqual(
    project.checks.map((c) => [c.kind, c.argv]),
    [
      ['test', ['npm', 'run', 'test']],
      ['database', ['npm', 'run', 'test:recovery']],
    ],
  )
})

test('the parent continues discussion while independent branch orchestrators work', async (t) => {
  const setup = await branchRepository(t)
  const controller = new AbortController()
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const bothEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  let started = 0
  let modelCalls = 0
  let acknowledgements = 0
  const running: Promise<DelegationStatus>[] = []
  const { session, runtime } = await captureSession(
    setup.root,
    join(setup.directory, 'agent'),
    [
      (pi) => {
        registerDelegation(pi)
        registerBranchTools(pi, async (request) => {
          running.push(
            runBranchTask(setup.store, request, controller.signal, async (assignment) => {
              started++

              if (started === 2) {
                entered()
              }

              await paused
              await writeFeature(assignment)
              return coordinatorEvidence(assignment)
            }),
          )
        })
      },
    ],
    async (context) => {
      modelCalls++

      if (modelCalls === 1) {
        return [
          { type: 'toolCall', id: 'fanout', name: 'delegate_branches', arguments: setup.input },
        ]
      }

      if (JSON.stringify(context).includes('Background task outcome.')) {
        acknowledgements++
        return [
          {
            type: 'text',
            text: 'The branch results have arrived. Continue the design discussion.',
          },
        ]
      }

      return [{ type: 'text', text: 'Discussion continues while the independent branches run.' }]
    },
  )

  try {
    await session.prompt(
      'Implement both documented extensions independently, then merge each to main after checks.',
    )
    await Promise.race([
      bothEntered,
      Promise.all(running).then((states) => {
        throw new Error('Workers stopped before starting: ' + JSON.stringify(states))
      }),
    ])
    assert.equal(running.length, 2)
    assert.ok((await setup.jobs.list()).every((job) => activeTask(job.state)))
    const before = modelCalls
    await session.prompt('While that runs, discuss the next API decision.')
    assert.equal(modelCalls, before + 1)
    assert.ok((await setup.jobs.list()).every((job) => activeTask(job.state)))
    assert.equal(await setup.store.checkpoint(), undefined)
    release()
    const completed = await Promise.all(running)
    assert.deepEqual(
      completed.map((state) => state.status),
      ['complete', 'complete'],
    )

    const completedIds = () =>
      session.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'custom_message' && entry.customType === 'pi-task-result'
            ? (entry.details as { taskIds: string[] }).taskIds
            : [],
        )

    for (let attempt = 0; attempt < 60 && new Set(completedIds()).size < 2; attempt++) {
      await delay(50)
    }

    await session.waitForIdle()
    assert.ok(acknowledgements > 0)
    assert.equal(new Set(completedIds()).size, 2)
  } finally {
    release()
    controller.abort()
    await Promise.all(running)
    await session.abort()
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})

test('published and later merged outcomes both notify the originating session once', async (t) => {
  const setup = await branchRepository(t)
  const { mergeToMain: _merge, ...publication } = setup.input
  const input = { ...publication, tasks: [publication.tasks[0]!] }
  const controller = new AbortController()
  const running: Promise<DelegationStatus>[] = []
  let phase: string = 'launch'
  let taskId = ''
  const { session, runtime } = await captureSession(
    setup.root,
    join(setup.directory, 'agent'),
    [
      (pi) => {
        registerDelegation(pi)
        registerBranchTools(pi, async (request) => {
          taskId = request.id
          running.push(
            runBranchTask(setup.store, request, controller.signal, async (assignment) => {
              await writeFeature(assignment)
              return coordinatorEvidence(assignment)
            }),
          )
        })
      },
    ],
    async () => {
      if (phase === 'launch') {
        phase = 'discussion'
        return [
          { type: 'toolCall', id: 'publish-task', name: 'delegate_branches', arguments: input },
        ]
      }

      if (phase === 'merge') {
        phase = 'discussion'
        return [
          {
            type: 'toolCall',
            id: 'merge-task',
            name: 'merge_branches',
            arguments: { ids: [taskId] },
          },
        ]
      }

      return [{ type: 'text', text: 'Task status acknowledged; discussion can continue.' }]
    },
  )
  const notices = () =>
    session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
  const waitForNotices = async (count: number) => {
    for (let attempt = 0; attempt < 60 && notices().length < count; attempt++) {
      await delay(50)
    }

    await session.waitForIdle()
    assert.equal(notices().length, count)
  }

  try {
    await session.prompt('Implement and publish the documented doubling extension.')
    assert.equal(running.length, 1)
    const published = await running[0]!
    assert.equal(published.status, 'published', published.error)
    assert.equal((await resolveRemote(setup.root)).base, setup.initial)
    await waitForNotices(1)
    phase = 'merge'
    await session.prompt('Merge that published task to main after its review cycle.')
    assert.equal(running.length, 2)
    const merged = await running[1]!
    assert.equal(merged.status, 'complete', merged.error)
    assert.equal(merged.id, published.id)
    assert.ok((merged.deliveryVersion ?? 0) > (published.deliveryVersion ?? 0))
    await waitForNotices(2)
    await session.reload()
    await delay(1100)
    assert.equal(notices().length, 2)
    assert.equal(await setup.store.checkpoint(), undefined)
  } finally {
    controller.abort()
    await Promise.all(running)
    await session.abort()
    session.dispose()
    await runtime.settleCredentialWrites()
  }
})
