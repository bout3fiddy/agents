import assert from 'node:assert/strict'
import test from 'node:test'
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui'
import { compactTool } from '../src/tool-activity.ts'

initTheme('dark', false)

test('job tools show readable nested parameters and receipts in the transcript', () => {
  const args = { id: 'j12', text: 'Update' }
  const view = new ToolExecutionComponent(
    'job_message',
    'call',
    args,
    {},
    compactTool('job_message'),
    { requestRender() {} } as TUI,
    process.cwd(),
  )
  const receipt =
    '{"revision":2,"messages":[{"text":"a, {b}","revision":2}],"sequence":9007199254740993}'
  const content = [
    { type: 'text' as const, text: receipt },
    { type: 'text' as const, text: 'A plain diagnostic.' },
  ]
  view.updateResult({ content, details: {}, isError: false })
  const read = () =>
    view
      .render(80)
      .map(stripTerminalSequences)
      .map((s) => s.trimEnd())
      .join('\n')
  const folded = read()
  assert.match(folded, /job message · j12/)
  assert.doesNotMatch(folded, /"messages"/)
  view.setExpanded(true)
  const expanded = read()
  assert.match(expanded, /job message · arguments\n\{\n  "id":/)
  assert.match(
    expanded,
    /Result\n\{\n  "revision": 2,\n  "messages": \[\n    \{\n      "text": "a, \{b\}"/,
  )
  assert.match(expanded, /"sequence": 9007199254740993\n\}\nA plain diagnostic\./)
  assert.equal(content[0]?.text, receipt)
  view.updateResult({
    content: [{ type: 'text', text: '{"partial":' }],
    details: {},
    isError: true,
  })
  assert.match(read(), /Error\n\{"partial":/)
  view.setExpanded(false)
  assert.match(read(), /Failed/)
})
