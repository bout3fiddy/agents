import assert from 'node:assert/strict'
import test from 'node:test'
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui'
import { compactTool } from '../src/tool-activity.ts'

initTheme('dark', false)

test('task controls show readable nested parameters and receipts in the transcript', () => {
  const args = { id: '385e5165-6088-496d-9a3b-cdf340152f6a', action: 'message', message: 'Update' }
  const view = new ToolExecutionComponent(
    'task_control',
    'call',
    args,
    {},
    compactTool('task_control'),
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
  assert.match(folded, /task control · message · 385e5165/)
  assert.doesNotMatch(folded, /"messages"/)
  view.setExpanded(true)
  const expanded = read()
  assert.match(expanded, /task control · arguments\n\{\n  "id":/)
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
