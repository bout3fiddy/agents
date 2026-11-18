import assert from 'node:assert/strict'
import test from 'node:test'
import { taskView } from '../src/context.ts'
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
