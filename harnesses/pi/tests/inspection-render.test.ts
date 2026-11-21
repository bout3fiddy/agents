import assert from 'node:assert/strict'
import test from 'node:test'
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TUI, visibleWidth } from '@earendil-works/pi-tui'
import { inspectionRenderers } from '../src/inspection-render.ts'

initTheme('dark', false)

function fixture() {
  const code = 'await Promise.allSettled(paths.map(path => tools.read({path})))'
  const view = new ToolExecutionComponent(
    'codemode',
    'inspection',
    { code },
    {},
    inspectionRenderers,
    { requestRender() {} } as TUI,
    process.cwd(),
  )
  const rows = (width = 100) => view.render(width).map(stripTerminalSequences)
  const click = (label: string) => {
    const lines = rows()
    const y = lines.findIndex((line) => line.includes(label))
    assert.ok(y >= 0, label)
    view.handleMouse({
      type: 'click',
      button: 'left',
      x: 3,
      y,
      screenX: 3,
      screenY: y,
      width: 100,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
    })
  }
  return { code, view, rows, click }
}

const paths = [
  '.pi/project-state.md',
  'design/brief.md',
  'design/design.md',
  'web/index.html',
  '.dockerignore',
  'Dockerfile',
]
const calls = paths.map((path, index) => ({
  id: 'read/' + index,
  name: 'read',
  args: JSON.stringify({ path, limit: 32 }),
  status: 'ok',
}))
const header = 'Script completed\nWall time 0.1 seconds\nOutput:\n'
const block = (text: string) => ({ type: 'text', text })

test('inspection stays readable through global expansion and raw drill-down', () => {
  const { code, view, rows, click } = fixture()
  const payload = paths
    .toReversed()
    .map(
      (path, index) =>
        '==> text ' +
        (index + 1) +
        '/6 <==\n' +
        JSON.stringify([path, '# Title\n' + 'body '.repeat(600)]),
    )
    .join('\n')
  view.updateResult({
    content: [block(header), block(payload)],
    details: { calls },
    isError: false,
  })
  assert.match(rows().join('\n'), /Done · 6 file reads/)
  assert.match(rows().join('\n'), /design\/brief\.md/)
  assert.ok(rows().length <= 4)
  view.setExpanded(true)
  const expanded = rows().join('\n')
  assert.match(expanded, /Dockerfile  # Title/)
  assert.doesNotMatch(expanded, /Promise\.allSettled|text 1\/6|"limit"|body body/)
  assert.ok(rows(32).every((line) => visibleWidth(line) <= 32))
  click('Show raw script and output')
  const raw = rows().join('\n')
  assert.ok(raw.includes(code))
  assert.match(raw, /"limit":32/)
  assert.match(raw, /body body/)
  click('Hide raw script and output')
  assert.equal(rows().join('\n'), expanded)
})

test('folded inspection exposes partial, cancelled and failed calls', () => {
  const { view, rows } = fixture()
  const call = calls[0]!
  const update = (status: string, isPartial = false) =>
    view.updateResult(
      {
        content: [block(header)],
        details: {
          calls: [
            ...calls,
            {
              ...call,
              args: '{"path":"missing.md"}',
              status,
              error: 'ENOENT: no such file or directory, access /private/path',
            },
          ],
        },
        isError: false,
      },
      isPartial,
    )
  update('running', true)
  assert.match(rows().join('\n'), /Running/)
  update('error')
  assert.match(rows().join('\n'), /Incomplete/)
  assert.match(rows().join('\n'), /1 failed/)
  assert.match(rows().join('\n'), /missing\.md · File not found/)
  assert.doesNotMatch(rows().join('\n'), /ENOENT|private\/path/)
  update('cancelled')
  assert.match(rows().join('\n'), /1 cancelled/)
  assert.match(rows().join('\n'), /missing\.md · cancelled/)
  view.updateResult({
    content: [
      block('Script failed\nWall time 0.3 seconds\nOutput:\n'),
      block('Script error:\nTypeError: invalid selector\nStack...'),
    ],
    details: { calls: [] },
    isError: true,
  })
  assert.match(rows().join('\n'), /TypeError: invalid selector/)
  assert.doesNotMatch(rows().join('\n'), /Stack/)
})
