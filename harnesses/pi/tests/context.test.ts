import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptView } from '../src/context.ts'

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
