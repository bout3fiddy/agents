import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './support.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import {
  Delegations,
  delegationDirectory,
  scopesOverlap,
  type DelegateInput,
} from '../src/delegation-state.ts'
import { runDelegation } from '../src/delegation-runner.ts'
import type { TaskCoordinatorEvidence } from '../src/task-coordinator.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { captureSession } from './session-support.ts'
import { inventory, snapshotHash } from '../src/paths.ts'

const input: DelegateInput = {
  task: 'Record the decision in docs',
  context: 'Keep pending choices',
  kind: 'documents',
  writePaths: ['decision.md'],
}
const origin = { session: 'test-session', model: 'test/model' }
const signal = () => new AbortController().signal
const result = (): TaskCoordinatorEvidence => ({
  result: {
    verdict: 'pass',
    summary: 'Recorded decision',
    findings: [],
    databaseImpact: false,
    evidence: ['Read back file'],
  },
  children: [],
  model: 'test/model',
  turns: 1,
  controlRevision: 0,
})

test('registry bounds jobs, protects aliases and recovers ownership', async () => {
  const { base, root } = await fixture()

  try {
    const jobs = new Delegations(new StateStore(root))
    const first = await jobs.start(input, origin, async () => {})
    await assert.rejects(
      jobs.start({ ...input, writePaths: ['DECISION.md'] }, origin, async () => {}),
      /already owned/,
    )
    assert.ok(scopesOverlap(['docs/**'], ['docs/component.md']))
    assert.ok(scopesOverlap(['**'], ['src/a.ts']))
    assert.ok(!scopesOverlap(['docs/a.md'], ['docs/b.md']))
    await jobs.start({ ...input, writePaths: ['other.md'] }, origin, async () => {})
    await assert.rejects(
      jobs.start({ ...input, writePaths: ['third.md'] }, origin, async () => {}),
      /Two background/,
    )
    await jobs.control(first.request.id, 'message', 'Preserve the chosen durability limit')
    assert.equal((await jobs.control(first.request.id, 'cancel')).cancelled, true)
    await atomicJson(join(delegationDirectory(jobs.store, first.request.id), 'status.json'), {
      ...first.state,
      status: 'cancelled',
    })
    await assert.rejects(
      jobs.start(input, origin, async () => {
        throw new Error('spawn failed')
      }),
      /spawn failed/,
    )
    assert.equal((await jobs.list()).at(-1)?.state.status, 'failed')
    await jobs.start(input, origin, async () => {})
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('documents preserve unrelated edits without a checkpoint', async () => {
  const { base, root } = await fixture()
  const store = new StateStore(root)

  try {
    await writeFile(join(root, 'decision.md'), '# Decision\n\nPending.\n')
    const jobs = new Delegations(store)
    const job = await jobs.start(input, origin, async () => {})
    let candidate = ''
    const state = await runDelegation(store, job.request.id, signal(), async (request) => {
      candidate = request.workspace
      await writeFile(join(request.workspace, 'decision.md'), '# Decision\n\nAccepted.\n')
      await writeFile(join(root, 'discussion.md'), '# New user question\n')
      return result()
    })
    assert.equal(state.status, 'complete', state.error)
    assert.equal(await readFile(join(root, 'decision.md'), 'utf8'), '# Decision\n\nAccepted.\n')
    assert.equal(await readFile(join(root, 'discussion.md'), 'utf8'), '# New user question\n')
    assert.equal(await store.checkpoint(), undefined)
    assert.deepEqual(state.changedPaths, ['decision.md'])
    assert.deepEqual(state.receipts, [])
    assert.equal(state.candidate, undefined)
    await assert.rejects(readFile(join(candidate, 'decision.md')), { code: 'ENOENT' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

for (const failure of [
  'conflict',
  'scope',
  'code',
  'format',
  'late-update',
  'cancel',
  'pending-journal',
  'review',
] as const) {
  test(`delegation fails closed for ${failure}`, async () => {
    const { base, root } = await fixture()
    const store = new StateStore(root)

    try {
      const jobs = new Delegations(store)
      const task: DelegateInput =
        failure === 'review'
          ? { ...input, kind: 'maintenance', writePaths: ['src/**'] }
          : {
              ...input,
              writePaths: failure === 'code' ? ['decision.md', 'src/**'] : input.writePaths,
            }
      const job = await jobs.start(task, origin, async () => {})
      const state = await runDelegation(store, job.request.id, signal(), async (request) => {
        const name = ['code', 'review'].includes(failure)
          ? 'src/value.js'
          : failure === 'scope'
            ? 'outside.md'
            : 'decision.md'
        await writeFile(
          join(request.workspace, name),
          failure === 'format'
            ? '# Wrong\n\n\nextra lines\n'
            : name.endsWith('.md')
              ? '# Accepted\n'
              : 'export const value = 1\n',
        )

        if (failure === 'conflict') {
          await writeFile(join(root, name), '# Concurrent edit\n')
        }

        if (failure === 'late-update') {
          await jobs.control(job.request.id, 'message', 'Change the decision')
        }

        if (failure === 'cancel') {
          await jobs.control(job.request.id, 'cancel')
        }

        if (failure === 'pending-journal') {
          await atomicJson(join(store.directory, 'integration.json'), {
            status: 'pending',
            edits: [],
          })
        }

        return result()
      })
      assert.equal(state.status, failure === 'cancel' ? 'cancelled' : 'needs_attention')
      assert.ok(state.error)
      assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 0\n')

      if (failure === 'conflict') {
        assert.equal(await readFile(join(root, 'decision.md'), 'utf8'), '# Concurrent edit\n')
      } else {
        await assert.rejects(readFile(join(root, 'decision.md')), { code: 'ENOENT' })
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
}

test('Pi keeps chatting, guards owned files and delivers once', async () => {
  const { base, root } = await fixture()
  const store = new StateStore(root)
  let taskId = ''
  let requests = 0
  let stage = 0
  const captured = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerDelegation(pi, async (request) => {
          taskId = request.id
        })
      },
    ],
    async () => {
      requests++

      if (stage++ === 0) {
        return [{ type: 'toolCall', id: 'dispatch', name: 'delegate_task', arguments: input }]
      }

      if (stage === 3) {
        return [
          {
            type: 'toolCall',
            id: 'conflicting-write',
            name: 'write',
            arguments: { path: 'decision.md', content: '# Wrong\n' },
          },
        ]
      }

      return [{ type: 'text', text: 'Which recovery limit do you prefer?' }]
    },
  )

  try {
    await captured.session.prompt('Delegate the document update and continue quizzing me.')
    assert.equal(requests, 2)
    assert.equal((await new Delegations(store).get(taskId)).state.status, 'queued')
    await captured.session.reload()
    assert.equal((await new Delegations(store).get(taskId)).state.status, 'queued')
    await captured.session.prompt('Keep discussing while the docs are edited.')
    await assert.rejects(readFile(join(root, 'decision.md')), { code: 'ENOENT' })
    const denied = captured.session.state.messages.filter(
      (message) => message.role === 'toolResult' && message.isError,
    )
    assert.ok(denied.length)
    const state = await runDelegation(store, taskId, signal(), async (request) => {
      await writeFile(join(request.workspace, 'decision.md'), '# Accepted\n')
      return result()
    })
    assert.equal(state.status, 'complete', state.error)
    const before = requests
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(requests, before + 1, 'Idle completion must wake the model exactly once')
    assert.equal(
      captured.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
        .length,
      1,
    )
    await captured.session.reload()
    await captured.session.prompt('Continue the next decision.')
    assert.equal(requests, before + 2)
    const results = captured.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
    assert.equal(results.length, 1)
    await captured.session.prompt('And the next?')
    assert.equal(
      captured.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
        .length,
      1,
    )
  } finally {
    captured.session.dispose()
    await captured.runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  }
})

for (const variant of ['pass', 'routine', 'baseline', 'skip', 'database', 'benchmark'] as const) {
  test(`code maintenance enforces ${variant} evidence`, async () => {
    const { base, root } = await fixture()
    const store = new StateStore(root)

    if (variant === 'skip') {
      const adapterPath = join(root, '.pi/harness.json')
      const adapter = JSON.parse(await readFile(adapterPath, 'utf8'))
      adapter.checks[0].argv = ['node', '-e', 'console.log("# skipped 1")']
      await atomicJson(adapterPath, adapter)
    }

    try {
      const jobs = new Delegations(store)
      const job = await jobs.start(
        { ...input, kind: 'maintenance', writePaths: ['src/**'], review: variant !== 'routine' },
        origin,
        async () => {},
      )
      const state = await runDelegation(store, job.request.id, signal(), async (request) => {
        await writeFile(join(request.workspace, 'src/value.js'), 'export const value = 1\n')
        const output = result()
        output.result.databaseImpact = variant === 'database'
        const snapshot = snapshotHash(await inventory(request.workspace))

        if (variant !== 'routine') {
          output.children.push({
            role: 'reviewer',
            model: 'claude-cli/claude-fable-5-2',
            snapshot,
            turns: 1,
            commands: [],
            result: output.result,
          })
        }

        if (variant === 'benchmark') {
          output.children.push({ ...output.children[0]!, role: 'performance' })
        }

        if (variant === 'baseline') {
          await writeFile(join(root, 'independent.md'), '# New project input\n')
        }

        return output
      })
      const passes = ['pass', 'routine'].includes(variant)
      assert.equal(state.status, passes ? 'complete' : 'needs_attention', state.error)
      assert.equal(
        await readFile(join(root, 'src/value.js'), 'utf8'),
        `export const value = ${passes ? 1 : 0}\n`,
      )

      if (variant === 'baseline') {
        assert.match(state.error!, /Project changed/)
      }

      if (variant === 'database') {
        assert.match(state.error!, /database-reviewer/)
      }

      if (variant === 'skip' || variant === 'benchmark') {
        assert.ok(state.receipts?.some((receipt) => receipt.status !== 'passed'))
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
}

test('two disjoint document tasks can finish concurrently without losing either edit', async () => {
  const { base, root } = await fixture()
  const store = new StateStore(root)

  try {
    const jobs = new Delegations(store)
    const first = await jobs.start(input, origin, async () => {})
    const second = await jobs.start({ ...input, writePaths: ['other.md'] }, origin, async () => {})
    let arrived = 0
    let ready!: () => void
    const barrier = new Promise<void>((resolve) => {
      ready = resolve
    })
    const states = await Promise.all(
      [first, second].map((job) =>
        runDelegation(store, job.request.id, signal(), async (request) => {
          await writeFile(
            join(request.workspace, request.checkpoint.writePaths[0]!),
            '# Accepted\n',
          )

          if (++arrived === 2) {
            ready()
          }

          await barrier
          return result()
        }),
      ),
    )
    assert.ok(
      states.every((state) => state.status === 'complete'),
      JSON.stringify(states),
    )
    assert.equal(await readFile(join(root, 'decision.md'), 'utf8'), '# Accepted\n')
    assert.equal(await readFile(join(root, 'other.md'), 'utf8'), '# Accepted\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('blocked workers preserve actionable host requirements', async () => {
  const { base, root } = await fixture()
  const store = new StateStore(root)

  try {
    const jobs = new Delegations(store)
    const job = await jobs.start(input, origin, async () => {})
    const state = await runDelegation(store, job.request.id, signal(), async () => ({
      ...result(),
      result: {
        ...result().result,
        verdict: 'blocked',
        summary: 'Dependency setup requires the host',
        hostActions: [
          { capability: 'dependencies', reason: 'Install the pinned project toolchain' },
        ],
      },
    }))
    assert.equal(state.status, 'needs_attention')
    assert.equal(state.hostActions?.[0]?.capability, 'dependencies')
    assert.equal(state.children?.length, 0)
    assert.equal(await readFile(join(root, 'src/value.js'), 'utf8'), 'export const value = 0\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
