import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { Type } from 'typebox'
import { registerHostWork } from '../src/host-work.ts'
import { textResult } from '../src/file-tools.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'

for (const outcome of ['done', 'stalled', 'waiting', 'paused']) {
  test('host milestone reaches ' + outcome + ' through the Pi settlement boundary', async (t) => {
    const { root, base } = await fixture()
    let modelSteps = 0
    let advances = 0
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerHostWork(pi)
          pi.registerTool({
            name: 'stage_service',
            label: 'Stage service',
            description: 'Stage fixture',
            parameters: Type.Object({}),
            async execute() {
              advances++
              return textResult('healthy')
            },
          })
        },
      ],
      async () => {
        modelSteps++
        const record = (state: string, detail: string) => [
          {
            type: 'toolCall' as const,
            name: 'host_work',
            id: String(modelSteps),
            arguments: { state, detail },
          },
        ]

        if (modelSteps === 1) {
          return record('active', 'Publish service. Verify it responds.')
        }

        if (modelSteps === 2 && ['waiting', 'paused'].includes(outcome)) {
          return record(outcome, 'Release owner holds the key.')
        }

        if (modelSteps === 3 && outcome === 'done') {
          return [{ type: 'toolCall', name: 'stage_service', id: 'stage', arguments: {} }]
        }

        if (modelSteps === 4 && outcome === 'done') {
          return record('done', 'Live probe returned healthy.')
        }

        assert.ok(modelSteps < 7, 'Repeated continuation without progress')
        return [{ type: 'text', text: 'The machine is up. Application setup is next.' }]
      },
    )
    t.after(async () => {
      await session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt('Launch the service and verify it.')
    await session.waitForIdle()
    const entries = session.sessionManager.getBranch()
    const count = (name: string) =>
      entries.filter((e) => e.type === 'custom_message' && e.customType === name).length
    assert.equal(advances, Number(outcome === 'done'))
    assert.equal(count('pi-host-work-next'), Number(outcome === 'done' || outcome === 'stalled'))
    assert.equal(count('pi-host-work-stalled'), Number(outcome === 'stalled'))
    assert.equal(session.messages.findLast((m) => m.role === 'assistant')?.stopReason, 'stop')
  })
}

test('an ordinary status question leaves a blocked host task waiting across reload', async (t) => {
  const { root, base } = await fixture()
  let step = 0
  const { session, runtime } = await captureSession(root, base, [registerHostWork], async (ctx) => {
    step++

    if (step === 1) {
      return [
        {
          type: 'toolCall',
          id: 'wait',
          name: 'host_work',
          arguments: {
            state: 'waiting',
            detail: 'Release owner must provide the signed manifest.',
          },
        },
      ]
    }

    if (step === 3) {
      assert.match(JSON.stringify(ctx.messages), /Release owner must provide the signed manifest/)
    }

    assert.ok(step <= 3)
    return [{ type: 'text', text: 'Waiting for the signed manifest.' }]
  })
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Continue the authorized preview as soon as release signs the manifest.')
  await session.waitForIdle()
  await session.reload()
  await session.prompt('Status only.')
  await session.waitForIdle()
  assert.equal(step, 3)
  assert.equal(session.messages.findLast((m) => m.role === 'assistant')?.stopReason, 'stop')
  assert.ok(
    !session.sessionManager
      .getBranch()
      .some((e) => e.type === 'custom_message' && e.customType === 'pi-host-work-next'),
  )
})

test('interrupting a host operation keeps it paused on the next user question', async (t) => {
  const { root, base } = await fixture()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let steps = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi)
        pi.registerTool({
          name: 'await_service',
          label: 'Await service',
          description: 'Hold until interrupted',
          parameters: Type.Object({}),
          async execute(_id, _input, signal) {
            started()

            if (!signal?.aborted) {
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true }),
              )
            }

            return textResult('Interrupted.')
          },
        })
      },
    ],
    async () => {
      steps++

      if (steps === 1) {
        return [
          {
            type: 'toolCall',
            id: 'open',
            name: 'host_work',
            arguments: { state: 'active', detail: 'Bring up the test service.' },
          },
        ]
      }

      if (steps === 2) {
        return [{ type: 'toolCall', id: 'wait', name: 'await_service', arguments: {} }]
      }

      return [{ type: 'text', text: 'Ready for discussion.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const request = session.prompt('Bring up the test service.')
  await entered
  await session.abort()
  await request
  await session.waitForIdle()
  await session.reload()
  const oldSteps = steps
  await session.prompt('Status only. What was the last step?')
  await session.waitForIdle()
  assert.equal(steps, oldSteps + 1)
  const entry = session.sessionManager
    .getBranch()
    .findLast((e) => e.type === 'custom' && e.customType === 'pi-host-work')
  assert.ok(entry?.type === 'custom')
  assert.equal((entry.data as { state: string }).state, 'paused')
})
