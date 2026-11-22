import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runBranchTask } from '../src/branch-runner.ts'
import {
  delegationDirectory,
  delegationView,
  type DelegationRequest,
} from '../src/delegation-state.ts'
import { atomicJson } from '../src/state.ts'
import { reviseTasks } from '../src/task-recovery.ts'
import { gitCommand, resolveRemote } from '../src/git-branches.ts'
import {
  assertRootUnchanged,
  branchRepository,
  coordinatorEvidence,
  feature,
  readCurrentMain,
  writeFeature,
} from './branch-support.ts'

test('two branch orchestrators fan out then revalidate against preceding merges', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch()
  assert.equal(await setup.store.checkpoint(), undefined)
  assert.equal(requests.length, 2)
  assert.equal(requests[0]!.branch?.base, requests[1]!.branch?.base)
  await writeFile(join(setup.root, 'discussion-notes.txt'), 'Live discussion remains untouched.\n')
  let entered = 0
  let release!: () => void
  const parallel = new Promise<void>((resolve) => {
    release = resolve
  })
  const seen: { workspace: string; phase: string; base: string }[] = []
  const tasks = requests.map((request) =>
    runBranchTask(setup.store, request, new AbortController().signal, async (assignment) => {
      assert.equal(assignment.designPath, setup.input.designPath)
      const context = JSON.parse(assignment.context)
      seen.push({ workspace: assignment.workspace, phase: context.phase, base: context.baseCommit })
      assert.equal(assignment.kind, 'branch')
      assert.match(context.instruction, /autonomously/)

      if (context.phase === 'implementation') {
        entered++

        if (entered === 2) {
          release()
        }

        await parallel
      } else {
        const other = feature(assignment).name === 'one' ? 'two' : 'one'
        assert.match(
          await readFile(join(assignment.originals, `src/${other}.js`), 'utf8'),
          /export function (?:doubled|tripled)/,
        )
      }

      await writeFeature(assignment)
      return coordinatorEvidence(assignment)
    }),
  )
  const results = await Promise.all(tasks)
  assert.deepEqual(
    results.map((result) => result.status),
    ['complete', 'complete'],
  )
  assert.equal(new Set(seen.map((item) => item.workspace)).size, 2)
  assert.equal(seen.length, 3)
  assert.equal(seen.filter((item) => item.phase === 'integration revalidation').length, 1)
  assert.match(await readCurrentMain(setup.root, 'src/one.js'), /return value \* 2/)
  assert.match(await readCurrentMain(setup.root, 'src/two.js'), /return value \* 3/)

  for (const result of results) {
    assert.ok(
      result.receipts?.some((check) => check.check === 'behavior' && check.status === 'passed'),
    )
    const remote = await gitCommand(setup.root, [
      'ls-remote',
      'origin',
      `refs/heads/${result.branch}`,
    ])
    assert.equal(remote.split('\t')[0], result.commit)
  }

  await assertRootUnchanged(setup.root, setup.initial)
  assert.equal(
    await readFile(join(setup.root, 'discussion-notes.txt'), 'utf8'),
    'Live discussion remains untouched.\n',
  )
})

test('host accepts the verified repair without a review round', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  let rounds = 0
  const state = await runBranchTask(
    setup.store,
    requests[0]!,
    new AbortController().signal,
    async (request) => {
      rounds++
      const context = JSON.parse(request.context)

      if (rounds === 2) {
        assert.match(context.previousFeedback, /behavior/)
        assert.match(context.previousFeedback, /failed/)
      }

      await writeFeature(request, rounds === 1)
      return coordinatorEvidence(request, {}, ['implementer'])
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(rounds, 2)
  assert.match(await readCurrentMain(setup.root, 'src/one.js'), /return value \* 2/)
})

test('a branch that keeps failing the same checks returns to the host', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  let rounds = 0
  const state = await runBranchTask(
    setup.store,
    requests[0]!,
    new AbortController().signal,
    async (request) => {
      rounds++
      assert.ok(rounds <= 2, 'An unchanged failing candidate must not loop')
      await writeFeature(request, true)
      return coordinatorEvidence(request, {}, ['implementer'])
    },
  )
  assert.equal(state.status, 'needs_attention')
  assert.equal(rounds, 2)
  assert.match(state.error!, /Branch repair made no progress/)
  assert.ok(state.receipts?.some((receipt) => receipt.status === 'failed'))
})

test('paused branches retain worktrees and revalidate revised instructions', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  const request = requests[0]!
  const first = await runBranchTask(
    setup.store,
    request,
    new AbortController().signal,
    async (assignment) => {
      await writeFeature(assignment)
      await setup.jobs.control(request.id, 'pause')
      return coordinatorEvidence(assignment)
    },
  )
  assert.equal(first.status, 'paused', first.error)
  assert.match(await readFile(join(first.candidate!, 'src/one.js'), 'utf8'), /return value \* 2/)

  // Older harnesses stored filename wildcards as literal paths.
  const legacyPaths = [...request.writePaths, 'runtime/test/local_*.test.ts']
  await atomicJson(join(delegationDirectory(setup.store, request.id), 'request.json'), {
    ...request,
    writePaths: legacyPaths,
    branch: { ...request.branch, design: { ...request.branch!.design, writePaths: legacyPaths } },
  })
  const [revised] = await reviseTasks(setup.jobs, {
    tasks: [
      {
        id: request.id,
        task: request.task,
        context: 'Recheck arithmetic after pausing.',
      },
    ],
  })
  assert.deepEqual(revised!.request.writePaths, legacyPaths)
  assert.equal(revised!.state.candidate, first.candidate)
  await setup.jobs.resume(request.id, setup.origin, async () => {})
  const resumed = await runBranchTask(
    setup.store,
    revised!.request,
    new AbortController().signal,
    async (assignment) => {
      assert.equal(assignment.workspace, first.candidate)
      assert.equal(assignment.resumed, true)
      assert.match(JSON.parse(assignment.context).parentContext, /Recheck arithmetic/)
      return { ...(await coordinatorEvidence(assignment)), controlRevision: 1 }
    },
  )
  assert.equal(resumed.status, 'complete', resumed.error)
  assert.match(await readCurrentMain(setup.root, 'src/one.js'), /return value \* 2/)
  await assertRootUnchanged(setup.root, setup.initial)
})

test('autonomous reviewer feedback repair has no fixed round ceiling', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  let rounds = 0
  const state = await runBranchTask(
    setup.store,
    requests[0]!,
    new AbortController().signal,
    async (request) => {
      rounds++

      if (rounds < 28) {
        if (rounds > 1) {
          assert.match(JSON.parse(request.context).previousFeedback, /Remaining reviewer finding/)
        }

        return coordinatorEvidence(
          request,
          {
            verdict: 'changes',
            summary: 'Remaining reviewer finding requires another repair.',
            findings: [
              {
                severity: 'required',
                location: 'src/one.js',
                problem: 'Complete the documented arithmetic.',
                evidence: 'Fixture repair remains pending.',
              },
            ],
          },
          [],
        )
      }

      await writeFeature(request)
      return coordinatorEvidence(request)
    },
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(rounds, 28)
})

test('out-of-scope edits retain the candidate and never publish a branch', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  const state = await runBranchTask(
    setup.store,
    requests[0]!,
    new AbortController().signal,
    async (request) => {
      await writeFeature(request)
      await writeFile(join(request.workspace, 'src/two.js'), 'export const base = 99\n')
      return coordinatorEvidence(request)
    },
  )
  assert.equal(state.status, 'needs_attention')
  assert.match(state.error ?? '', /outside its assignment/)
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
  assert.equal(await gitCommand(setup.root, ['ls-remote', 'origin', 'refs/heads/pi/*']), '')
  await access(state.candidate!)
})

test('cancellation stops branch publication and retains in-progress evidence', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  const controller = new AbortController()
  const state = await runBranchTask(
    setup.store,
    requests[0]!,
    controller.signal,
    async (request) => {
      await writeFeature(request)
      const result = await coordinatorEvidence(request)
      controller.abort(new Error('Parent cancelled the branch task'))
      return result
    },
  )
  assert.equal(state.status, 'cancelled')
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
  assert.equal(await gitCommand(setup.root, ['ls-remote', 'origin', 'refs/heads/pi/*']), '')
  await access(state.candidate!)
})

test('branch execution defaults to publication until a later explicit merge request', async (t) => {
  const setup = await branchRepository(t)
  const { mergeToMain: _merge, ...input } = setup.input
  const { requests } = await setup.launch({ ...input, tasks: [input.tasks[0]!] })
  let calls = 0
  const published = await runBranchTask(
    setup.store,
    requests[0]!,
    new AbortController().signal,
    async (assignment) => {
      calls++
      await writeFeature(assignment)
      return coordinatorEvidence(assignment)
    },
  )
  assert.equal(published.status, 'published', published.error)
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
  assert.equal(await setup.store.checkpoint(), undefined)
  const remote = await gitCommand(setup.root, [
    'ls-remote',
    'origin',
    `refs/heads/${published.branch}`,
  ])
  assert.equal(remote.split('\t')[0], published.commit)

  const outsider = join(setup.directory, 'other-writer')
  await gitCommand(setup.root, ['worktree', 'add', '--detach', outsider, setup.initial])
  await writeFile(join(outsider, 'upstream.txt'), 'Preserve the preceding main change.\n')
  await gitCommand(outsider, ['add', 'upstream.txt'])
  await gitCommand(outsider, ['commit', '-m', 'Independent upstream change'])
  await gitCommand(outsider, ['push', 'origin', 'HEAD:main'])
  const updatedMain = (await resolveRemote(setup.root)).base
  await atomicJson(join(delegationDirectory(setup.store, published.id), 'request.json'), {
    ...requests[0]!,
    createdAt: new Date(Date.now() - 120000).toISOString(),
  })
  const resumed: DelegationRequest[] = []
  const launch = async (request: DelegationRequest) => {
    resumed.push(request)
  }
  await setup.jobs.requestMerge([requests[0]!.id], setup.origin, launch)
  assert.equal((await setup.jobs.get(published.id)).state.status, 'queued')
  await setup.jobs.requestMerge([requests[0]!.id], setup.origin, launch)
  assert.equal(resumed.length, 1, 'A duplicate queued merge must not spawn another supervisor')
  const checkedBases: string[] = []
  const merged = await runBranchTask(
    setup.store,
    resumed[0]!,
    new AbortController().signal,
    async (assignment) => {
      calls++
      checkedBases.push(JSON.parse(assignment.context).baseCommit)
      assert.equal(assignment.workspace, published.candidate)
      await writeFeature(assignment)
      return coordinatorEvidence(assignment)
    },
  )
  assert.equal(merged.status, 'complete', merged.error)
  assert.equal(merged.branch, published.branch)
  assert.equal(merged.candidate, published.candidate)
  assert.ok(checkedBases.includes(updatedMain), 'Merge requires checks on current main')
  assert.ok(calls > 1, 'Publication evidence alone cannot authorize integration')
  assert.ok((merged.deliveryVersion ?? 0) > (published.deliveryVersion ?? 0))
  assert.match(await readCurrentMain(setup.root, 'src/one.js'), /return value \* 2/)
  assert.equal(
    await readCurrentMain(setup.root, 'upstream.txt'),
    'Preserve the preceding main change.',
  )
  await setup.jobs.requestMerge([requests[0]!.id], setup.origin, launch)
  assert.equal(resumed.length, 1, 'An already merged task must remain idempotent')
  assert.equal(
    (await setup.jobs.get(requests[0]!.id)).state.deliveryVersion,
    merged.deliveryVersion,
  )
  await assertRootUnchanged(setup.root, setup.initial)
})

test('active implementation accepts merge authority without another supervisor', async (t) => {
  const setup = await branchRepository(t)
  const { mergeToMain: _merge, ...input } = setup.input
  const { requests } = await setup.launch({ ...input, tasks: [input.tasks[0]!] })
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const controller = new AbortController()
  const running = runBranchTask(
    setup.store,
    requests[0]!,
    controller.signal,
    async (assignment) => {
      entered()
      await paused
      await writeFeature(assignment)
      return coordinatorEvidence(assignment)
    },
  )

  try {
    await Promise.race([
      started,
      running.then((state) => {
        throw new Error('Task stopped before implementation: ' + JSON.stringify(state))
      }),
    ])
    let extraSupervisors = 0
    await setup.jobs.requestMerge([requests[0]!.id], setup.origin, async () => {
      extraSupervisors++
    })
    assert.equal(extraSupervisors, 0)
    release()
    const merged = await running
    assert.equal(merged.status, 'complete', merged.error)
    assert.match(await readCurrentMain(setup.root, 'src/one.js'), /return value \* 2/)
  } finally {
    release()
    controller.abort()
    await running
  }
})

test('a blocked branch delivers its current host actions and clears them on resume', async (t) => {
  const setup = await branchRepository(t)
  const {
    requests: [request],
  } = await setup.launch({ ...setup.input, tasks: setup.input.tasks.slice(0, 1) })
  const actions = [
    { capability: 'dependencies' as const, reason: 'Verify the pinned compiler on the host.' },
    { capability: 'project-policy' as const, reason: 'Run the repository-owned release check.' },
  ]
  const state = await runBranchTask(
    setup.store,
    request!,
    new AbortController().signal,
    async (assignment) => {
      const evidence = await coordinatorEvidence(assignment, {
        verdict: 'blocked',
        summary: 'Host verification required.',
        hostActions: actions,
      })
      evidence.children[0]!.result.hostActions = [
        { capability: 'git', reason: 'Superseded child proposal.' },
      ]
      return evidence
    },
  )
  assert.equal(state.status, 'needs_attention')
  const delivered = delegationView(await setup.jobs.get(request!.id))
  assert.deepEqual(delivered.hostActions, actions)
  assert.match(delivered.error!, /Host verification required/)
  const original = join(delegationDirectory(setup.store, request!.id), state.progressFile!)
  const originalReceipt = await readFile(original)
  await reviseTasks(setup.jobs, {
    tasks: [{ id: request!.id, task: request!.task, context: 'Continue scoped verification.' }],
  })
  const resumed = await setup.jobs.resume(request!.id, setup.origin, async () => {})
  assert.equal(delegationView(resumed).hostActions, undefined)
  const interrupted = new AbortController()
  const cancelled = await runBranchTask(
    setup.store,
    request!,
    interrupted.signal,
    async (assignment) => {
      const context = JSON.parse(assignment.context)
      assert.deepEqual(context.previousHostHandoff, {
        attempt: state.progressFile,
        actions,
      })
      interrupted.abort()
      return coordinatorEvidence(assignment, { verdict: 'blocked', hostActions: actions })
    },
  )
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.hostActions, undefined)
  assert.notEqual(cancelled.progressFile, state.progressFile)
  assert.deepEqual(await readFile(original), originalReceipt)
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
})

test('merge refusal directs the host to recover the actual branch gate', async (t) => {
  const setup = await branchRepository(t)
  const { requests } = await setup.launch({ ...setup.input, tasks: [setup.input.tasks[0]!] })
  const id = requests[0]!.id
  const { state } = await setup.jobs.get(id)
  await atomicJson(join(delegationDirectory(setup.store, id), 'status.json'), {
    ...state,
    status: 'needs_attention',
    error: 'Required checks failed: harness-lint',
  })
  let launches = 0
  await assert.rejects(
    setup.jobs.requestMerge([id], setup.origin, async () => {
      launches++
    }),
    (e) => {
      assert.ok(e instanceof Error)
      assert.ok(e.message.includes(id) && e.message.includes('needs_attention'))
      assert.match(e.message, /review_receipts/)
      assert.match(e.message, /harness-lint/)
      return true
    },
  )
  assert.equal(launches, 0)
  assert.equal((await resolveRemote(setup.root)).base, setup.initial)
})
