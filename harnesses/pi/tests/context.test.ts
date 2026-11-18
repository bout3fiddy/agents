import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptView, taskView } from '../src/context.ts'
import type { TaskState } from '../src/state.ts'

test('orchestrator status excludes raw worker logs from its context', () => {
  const task: TaskState = {
    id: 'probe',
    designHash: 'accepted',
    status: 'complete',
    phase: 'complete',
    round: 1,
    receipts: [],
    evidence: [
      {
        role: 'reviewer',
        snapshot: 'snapshot',
        model: 'fixture',
        turns: 1,
        result: {
          verdict: 'pass',
          summary: 'Contract verified',
          findings: [],
          databaseImpact: false,
          evidence: [],
        },
        commands: [
          {
            argv: ['test'],
            exitCode: 0,
            output: 'RAW_COMMAND_OUTPUT'.repeat(3000),
            timedOut: false,
            aborted: false,
            truncated: false,
            durationMs: 1,
          },
        ],
      },
    ],
  }
  const output = JSON.stringify(taskView(task))
  assert.ok(output.length < 1000)
  assert.match(output, /Contract verified/)
  assert.doesNotMatch(output, /RAW_COMMAND_OUTPUT/)
})

test('a denied tsx IPC socket explains the failed gate without changing its verdict', () => {
  const output =
    '> tsx --test "**/*.test.ts"\nError: listen EPERM: operation not permitted ' +
    '/tmp/pi-command-example/tsx-501/4160.pipe'
  const result = {
    argv: ['npm', 'test'],
    exitCode: 1,
    output,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 100,
  }
  const receipt = { check: 'tests', snapshot: 'frozen', status: 'failed' as const, result }
  const view = receiptView(receipt)
  assert.match(view.diagnostic!, /node --import tsx --test/)
  assert.equal(view.status, 'failed')
  assert.equal(view.output, output)
  assert.equal(
    receiptView({
      ...receipt,
      result: { ...result, output: output.replace('tsx-501/4160.pipe', 'web.sock') },
    }).diagnostic,
    undefined,
  )
  assert.equal(receiptView({ ...receipt, status: 'passed' }).diagnostic, undefined)
})
