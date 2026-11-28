/** A source Pi host in its own short-lived process: no sender timer survives its send. */
import assert from 'node:assert/strict'
import { createHarness } from '../src/extension.ts'
import { captureSession } from './session-support.ts'

const [agentDir, wrapper, key] = process.argv.slice(2)
assert.ok(agentDir && wrapper && key)
const build = key === 'build'
const args = {
  destination: 'receiver',
  key,
  intent: build ? 'build' : 'discuss',
  brief: build ? 'Implement the fixture value' : 'Explain the fixture value',
}
const harness = createHarness({ handoffs: { agentDir, wrapper } })
let result = ''
const { session, runtime } = await captureSession(
  process.cwd(),
  agentDir,
  [harness],
  async (ctx) => {
    const messages = ctx.messages.filter((m) => m.role === 'toolResult')

    if (!messages.length) {
      return [
        {
          type: 'toolCall',
          name: 'codemode',
          id: 'send',
          arguments: {
            code:
              'text(await tools.project_list({})); ' +
              `text(await tools.project_send(${JSON.stringify(args)}))`,
          },
        },
      ]
    }

    result = JSON.stringify(messages)
    return [{ type: 'text', text: 'Request sent.' }]
  },
)

try {
  await session.prompt('UNRELATED_SOURCE_SENTINEL. Send the authorized fixture request.')
  const id = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/.exec(result)?.[0]
  assert.ok(id, result)
  console.log(id)
} finally {
  session.dispose()
  await runtime.settleCredentialWrites()
}
