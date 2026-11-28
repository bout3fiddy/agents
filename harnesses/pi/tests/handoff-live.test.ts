import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createHarness } from '../src/extension.ts'
import { handleRequest } from '../src/handoff-session.ts'
import { HandoffStore } from '../src/handoff-store.ts'
import { jobStore } from '../src/job-tools.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { gate } from './whiteboard-support.ts'

const reply = (text: string) => [{ type: 'text' as const, text }]
const script = (code: string) => [
  { type: 'toolCall' as const, name: 'codemode', id: 'call', arguments: { code } },
]

test(
  'a busy live pih serves a read-only peer separately; the source receives its reply',
  { timeout: 20000 },
  async (t) => {
    const { base, root } = await fixture()
    t.after(() => rm(base, { recursive: true, force: true }))
    const source = join(base, 'source')
    const agentDir = join(base, 'agent')
    await mkdir(source)
    const mail = HandoffStore.open(agentDir, true)!
    mail.enroll(source, 'source')
    t.after(() => mail.close())
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultModel: 'capture',
        defaultProvider: 'capture',
      }),
    )
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'PRIVATE_INTERACTIVE_CONTEXT')
    const busy = gate()
    const foreground = gate()
    let runtime: ModelRuntime
    const destination = await captureSession(
      root,
      agentDir,
      [
        createHarness({
          handoffs: {
            agentDir,
            tickMs: 20,
            handle: (db, cwd, request, signal) =>
              handleRequest(db, cwd, request, signal, { runtime, agentDir }),
          },
        }),
      ],
      async (ctx) => {
        const messages = JSON.stringify(ctx.messages)

        if (messages.includes('PRIVATE_BUSY_NOTE')) {
          busy.release()
          await foreground.wait
          return reply('Local conversation finished.')
        }

        assert.doesNotMatch(
          messages + (ctx.systemPrompt ?? ''),
          /PRIVATE_SOURCE_NOTE|PRIVATE_INTERACTIVE_CONTEXT/,
        )
        const results = ctx.messages.filter((m) => m.role === 'toolResult')

        if (!results.length) {
          return [
            {
              type: 'toolCall',
              name: 'job_start',
              id: 'not-authorized',
              arguments: {
                title: 'No',
                task: 'Unauthorized',
                writePaths: ['src/value.js'],
              },
            },
          ]
        }

        assert.equal(results[0]?.isError, true, 'a discuss request cannot start a job')
        return reply('The value is maintained in src/value.js.')
      },
    )
    runtime = destination.runtime
    const local = destination.session.prompt('PRIVATE_BUSY_NOTE: hold this conversation open.')
    await busy.wait
    mail.enroll(root, 'destination')
    const listening = () =>
      mail.list().some((p) => p.name === 'destination' && p.presence === 'live')

    for (let tick = 0; !listening() && tick < 100; tick++) {
      await delay(20)
    }

    assert.ok(listening(), 'enrollment attached the already-busy host without a second turn')
    const received = gate()
    const sender = await captureSession(
      source,
      agentDir,
      [
        createHarness({
          handoffs: { agentDir, tickMs: 20, wrapper: join(base, 'must-not-launch') },
        }),
      ],
      async (ctx) => {
        const messages = JSON.stringify(ctx.messages)
        const terminal = /Project request ([a-f0-9-]{36}) settled/.exec(messages)?.[1]

        if (terminal) {
          if (!messages.includes('The value is maintained in src/value.js.')) {
            return script(`text(await tools.project_status({id:${JSON.stringify(terminal)}}))`)
          }

          received.release()
          return reply('Received the project reply.')
        }

        if (!ctx.messages.some((m) => m.role === 'toolResult')) {
          return script(
            'text(await tools.project_send({destination:"destination",key:"ask",' +
              'intent:"discuss",brief:"Where is the value maintained?"}))',
          )
        }

        return reply('Waiting for the answer.')
      },
    )

    try {
      await sender.session.prompt('PRIVATE_SOURCE_NOTE: ask the other project.')

      await received.wait
      assert.equal(jobStore(root).list().length, 0)
      assert.equal(mail.list()[0]?.presence, 'live')
    } finally {
      foreground.release()
      await local
      await sender.session.waitForIdle()
      await sender.session.dispose()
      await destination.session.dispose()

      // Disposing an embedded session invalidates its ctx without a shutdown event.
      const detached = () => mail.list().every((p) => p.presence === 'offline')

      for (let tick = 0; !detached() && tick < 100; tick++) {
        await delay(20)
      }

      assert.ok(detached(), 'both live hosts released their leases')
    }
  },
)
