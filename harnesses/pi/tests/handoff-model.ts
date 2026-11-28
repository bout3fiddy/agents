/** Loaded only by the disposable test launcher. Replace model I/O, not the host, job or checks. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context, AssistantMessage } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { registerCapture } from './session-support.ts'

function call(
  name: string,
  args: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'],
): AssistantMessage['content'] {
  return [{ type: 'toolCall', name, arguments: args, id: name }]
}

async function respond(ctx: Context): Promise<AssistantMessage['content']> {
  const added = ctx.messages.flatMap((m) => (m.role === 'system' && m.toolsAdded) || [])
  const names = [...(ctx.tools ?? []), ...added].map((t) => t.name).sort()
  const turns = ctx.messages.filter((m) => m.role === 'toolResult').length
  assert.doesNotMatch(JSON.stringify(ctx.messages), /UNRELATED_SOURCE_SENTINEL/)
  assert.equal(process.env.HANDOFF_TEST_CREDENTIAL, undefined)

  if (names?.includes('submit_result')) {
    assert.ok(!names.includes('project_send'))

    if (existsSync(join(process.env.PI_HARNESS_AGENT_DIR!, 'blocked'))) {
      if (turns) {
        return [{ type: 'text', text: 'Worker blocked.' }]
      }

      return call('submit_result', {
        verdict: 'blocked',
        summary: 'Fixture needs a dependency.',
        hostActions: [{ capability: 'dependencies', reason: 'Install the missing dependency.' }],
        databaseImpact: false,
        findings: [],
        evidence: ['Required dependency absent.'],
      })
    }

    if (turns === 0) {
      return call('project_edit', {
        path: 'src/value.js',
        oldText: 'value = 0',
        newText: 'value = 1',
      })
    }

    if (turns === 1) {
      return call('submit_result', {
        verdict: 'pass',
        summary: 'Changed the fixture value.',
        findings: [],
        databaseImpact: false,
        evidence: ['Updated src/value.js.'],
      })
    }

    return [{ type: 'text', text: 'Worker finished.' }]
  }

  const build = JSON.stringify(ctx.messages).includes('Implement the fixture value')
  assert.deepEqual(
    names,
    build ? ['job_start', 'project_read', 'project_search'] : ['project_read', 'project_search'],
  )

  if (build && !turns) {

    // Both senders must have exited before a model may authorize the destination job.
    const gate = join(process.env.PI_HARNESS_AGENT_DIR!, 'released')

    for (let tick = 0; !existsSync(gate) && tick < 1000; tick++) {
      await delay(25)
    }

    assert.ok(existsSync(gate), 'release gate')
    return call('job_start', { title: 'Everything', task: 'Overbroad', writePaths: ['**'] })
  }

  if (build && turns === 1) {
    assert.match(JSON.stringify(ctx.messages.at(-1)), /specific destination scope/)
    return call('job_start', {
      title: 'Set value',
      task: 'Set the value to 1.',
      writePaths: ['src/value.js'],
    })
  }

  return [{ type: 'text', text: build ? 'Job requested.' : 'Discussion reply from destination.' }]
}

const create = ModelRuntime.create.bind(ModelRuntime)
ModelRuntime.create = async (options) => {
  const runtime = await create({ ...options, refreshOnCreate: false })
  registerCapture(runtime, respond, true)
  const model = runtime.getModel('capture', 'capture')!
  runtime.getModel = () => model
  return runtime
}
