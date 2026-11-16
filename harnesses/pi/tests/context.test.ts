import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { projectContext, taskView } from '../src/context.ts'
import { design } from './support.ts'
import type { TaskState } from '../src/state.ts'

test('accepted context excludes old exploration and preserves new input', () => {
  const checkpoint = {
    ...design,
    version: 1,
    hash: 'accepted',
    acceptedAt: new Date(2000).toISOString(),
  }
  const messages: AgentMessage[] = [
    { role: 'user', content: 'REJECTED_DESIGN_MARKER', timestamp: 1000 },
    { role: 'user', content: 'Keep the new constraint', timestamp: 3000 },
    {
      role: 'branchSummary',
      summary: 'REJECTED_DESIGN_MARKER',
      timestamp: 4000,
      fromId: 'old',
    } as AgentMessage,
    {
      role: 'compactionSummary',
      summary: 'REJECTED_DESIGN_MARKER',
      timestamp: 5000,
      tokensBefore: 100,
    } as AgentMessage,
  ]
  const projected = projectContext(messages, checkpoint)
  assert.doesNotMatch(JSON.stringify(projected), /REJECTED_DESIGN_MARKER/)
  assert.match(JSON.stringify(projected), /Keep the new constraint/)
  assert.deepEqual(projectContext(projected, checkpoint), projected)
  assert.equal(projectContext(messages).length, messages.length)
})

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
