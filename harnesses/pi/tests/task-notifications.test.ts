import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { Delegations, delegationDirectory } from '../src/delegation-state.ts'

for (const mode of ['idle', 'busy', 'queued'] as const) {
  test(`completed jobs notify once in one batch while ${mode}`, async () => {
    const { root, base } = await fixture()
    const jobs = new Delegations(new StateStore(root))
    let requests = 0
    let acknowledge = 0
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const working = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerDelegation(pi, async () => {})
        },
      ],
      async (context) => {
        requests++

        if (JSON.stringify(context).includes('Background task outcome.')) {
          acknowledge++
          assert.match(JSON.stringify(context), /First finished/)
          assert.match(JSON.stringify(context), /Second finished/)

          if (mode === 'queued') {
            assert.match(JSON.stringify(context), /NEWER_USER_PRIORITY/)
          }

          return [{ type: 'text', text: 'Both updates finished. Continuing the discussion.' }]
        }

        if (requests === 1) {
          return ['one.md', 'two.md'].map((path, index) => ({
            type: 'toolCall' as const,
            id: `dispatch-${index}`,
            name: 'delegate_task',
            arguments: {
              task: `Update ${path}`,
              kind: 'documents',
              writePaths: [path],
              context: '',
            },
          }))
        }

        if (mode !== 'idle' && requests === 3) {
          entered()
          await paused
        }

        return [{ type: 'text', text: 'Which constraint matters next?' }]
      },
    )

    try {
      await session.prompt('Update the documents and continue discussion.')
      const initialRequests = requests
      const conversation = mode !== 'idle' ? session.prompt('Discuss recovery options.') : undefined

      if (conversation) {
        await working
      }

      if (mode === 'queued') {
        await session.prompt('NEWER_USER_PRIORITY: discuss latency first.', {
          streamingBehavior: 'steer',
        })
      }

      await Promise.all(
        (await jobs.list()).map((job, index) =>
          atomicJson(join(delegationDirectory(jobs.store, job.request.id), 'status.json'), {
            ...job.state,
            status: 'complete',
            summary: index ? 'Second finished' : 'First finished',
          }),
        ),
      )

      if (conversation) {
        await delay(1100)
        assert.equal(acknowledge, 0, 'Completion must not interrupt an in-flight model request')
        release()
        await conversation
      } else {
        for (let attempt = 0; attempt < 50; attempt++) {
          if (acknowledge) {
            break
          }

          await delay(50)
        }

        await session.waitForIdle()
      }

      assert.equal(acknowledge, 1)
      assert.equal(requests, initialRequests + (mode !== 'idle' ? 2 : 1))
      const messages = session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
      assert.equal(messages.length, 1)
      await session.reload()
      await delay(1100)
      assert.equal(acknowledge, 1, 'Reload must not repeat a completion wake-up')
    } finally {
      release()
      await session.abort()
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    }
  })
}
