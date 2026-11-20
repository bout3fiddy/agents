import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Type } from 'typebox'
import { registerGitHubRunWatch } from '../src/github-run-watch.ts'
import { textResult } from '../src/file-tools.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'

const changed = {
  moved: 'b'.repeat(40),
  conflict: 'CONFLICTING',
  closed: 'CLOSED',
  mismatch: 'different commit',
}

for (const outcome of ['success', 'failure', 'unavailable', ...Object.keys(changed)]) {
  test(`an idle session continues after GitHub run ${outcome} across reload`, async () => {
    const { root, base } = await fixture()
    let completed = false
    let queried = 0
    let unavailable = 0
    let steps = 0
    let followUps = 0
    let release!: () => void
    let start!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      start = resolve
    })
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerGitHubRunWatch(
            pi,
            async (args) => {
              if (args[1] === 'graphql') {
                return JSON.stringify({
                  number: 42,
                  state: completed && outcome === 'closed' ? 'CLOSED' : 'OPEN',
                  headRefOid: (completed && outcome === 'moved' ? 'b' : 'a').repeat(40),
                  isInMergeQueue: false,
                  mergeable: completed && outcome === 'conflict' ? 'CONFLICTING' : 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                })
              }

              assert.equal(args.at(-1), 'repos/fixture/project/actions/runs/75')
              queried++

              if (completed && outcome === 'unavailable') {
                unavailable++
                throw new Error('lookup unavailable')
              }

              return JSON.stringify({
                id: 75,
                status: completed && !(outcome in changed) ? 'completed' : 'in_progress',
                conclusion: completed && !(outcome in changed) ? outcome : null,
                head_sha: (completed && outcome === 'mismatch' ? 'b' : 'a').repeat(40),
                run_attempt: 2,
                run_started_at: '2026-11-20T18:54:28Z',
                updated_at: '2026-11-20T19:08:03Z',
              })
            },
            20,
          )
          pi.registerTool({
            name: 'continue_build',
            label: 'Continue build',
            description: 'Record the next fixture action.',
            parameters: Type.Object({}),
            async execute() {
              followUps++
              return textResult('continued')
            },
          })
        },
      ],
      async (ctx) => {
        steps++

        if (steps <= 2) {
          return [
            {
              type: 'toolCall',
              name: 'watch_github_run',
              id: 'watch-' + steps,
              arguments: {
                repository: 'Fixture/Project',
                runId: 75,
                ...(outcome in changed && {
                  pullRequest: { number: 42, expectedHead: 'a'.repeat(40) },
                }),
                followUp: steps === 1 ? 'First plan' : 'Compare with the seven-minute target.',
              },
            },
          ]
        }

        const last = JSON.stringify(ctx.messages.at(-1)?.content)

        if (last.includes('Independent question')) {
          start()
          await hold
        }

        if (last.includes('GitHub Actions watch finished.')) {
          assert.match(last, /seven-minute target/)
          assert.ok(last.includes(changed[outcome as keyof typeof changed] ?? outcome))

          if (outcome !== 'unavailable') {
            assert.ok(last.includes('a'.repeat(40)))
          }

          return [{ type: 'toolCall', name: 'continue_build', id: 'next', arguments: {} }]
        }

        return [{ type: 'text', text: 'Acknowledged.' }]
      },
    )

    try {
      await session.prompt('Continue after the CI run.')
      await session.waitForIdle()
      await delay(90)
      assert.ok(queried > 0)
      assert.equal(steps, 3)
      assert.equal(followUps, 0)
      await session.reload()

      if (outcome === 'failure') {
        const discussion = session.prompt('Independent question')
        await entered
        completed = true
        await delay(80)
        assert.equal(followUps, 0)
        release()
        await discussion
      }

      completed = true

      for (let i = 0; i < 100; i++) {
        if (followUps) {
          break
        }

        await delay(20)
      }

      await session.waitForIdle()
      assert.equal(followUps, 1)
      assert.equal(unavailable, outcome === 'unavailable' ? 3 : 0)
      const settled = queried
      await session.reload()
      await delay(90)
      assert.equal(followUps, 1)
      assert.equal(queried, settled)
    } finally {
      release()
      await session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    }
  })
}
