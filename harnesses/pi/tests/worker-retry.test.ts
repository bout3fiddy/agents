import assert from 'node:assert/strict'
import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { runWorker } from '../src/worker.ts'
import { runTaskCoordinator } from '../src/task-coordinator.ts'
import { fixture, hashes } from './support.ts'
import { captureSession } from './session-support.ts'

const overloaded = 'Codex error: Our servers are currently overloaded. Please try again later.'

for (const role of ['implementer', 'task-coordinator'] as const) {
  for (const outcome of ['recovered', 'exhausted', 'terminal after submission'] as const) {
    test(`${role} model outcome: ${outcome}`, async (t) => {
      const { root, base, store } = await fixture()
      t.after(() => rm(base, { recursive: true, force: true }))
      let calls = 0
      const { session, runtime } = await captureSession(root, base, [], async () => {
        calls++

        if (outcome === 'exhausted' || (outcome === 'recovered' && calls === 1)) {
          throw new Error(overloaded)
        }

        if (calls === (outcome === 'recovered' ? 2 : 1)) {
          return [
            {
              type: 'toolCall',
              id: 'submission',
              name: 'submit_result',
              arguments: {
                verdict: 'pass',
                summary: 'The fixture completed.',
                findings: [],
                databaseImpact: false,
                evidence: ['Fixture receipt'],
              },
            },
          ]
        }

        if (outcome === 'terminal after submission') {
          throw new Error('Invalid credentials for fixture')
        }

        return [{ type: 'text', text: 'Submitted.' }]
      })
      t.after(() => session.dispose())
      const model = runtime.getModel('capture', 'capture')!
      t.mock.method(runtime, 'getModel', () => model)
      t.mock.method(ModelRuntime, 'create', async () => runtime)
      const workspace = join(base, 'candidate')
      await cp(join(root, 'src'), join(workspace, 'src'), { recursive: true })
      const request = {
        task: 'Inspect the fixture',
        context: 'Read-only inspection',
        kind: 'research' as const,
        workspace,
        originals: root,
        project: { root, checks: [], databasePaths: [], instrumentationPaths: [] },
        checkpoint: (await store.checkpoint())!,
        model: 'openai-codex/gpt-6.1-sol',
        baseline: await hashes(root),
        outputPath: join(root, '.pi', 'traces', 'task', 'result.json'),
      }
      const running =
        role === 'task-coordinator'
          ? runTaskCoordinator(request, new AbortController().signal)
          : runWorker({ ...request, role })

      if (outcome === 'recovered') {
        assert.equal((await running).result.verdict, 'pass')
        assert.equal(calls, 3)
      } else {
        const exhausted = outcome === 'exhausted'
        await assert.rejects(running, exhausted ? /overloaded/ : /Invalid credentials/)
        assert.equal(calls, exhausted ? 3 : 2)
      }
    })
  }
}
