import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { ConversationRenderer, visibleLinks } from '../src/workers-render.ts'
import { WorkersView } from '../src/workers-ui.ts'
import type { WorkerRow } from '../src/workers-data.ts'
import { messageEntries, type ConversationEntry } from '../src/worker-live.ts'

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme
const colorTheme = {
  fg: (_color: string, text: string) => `\x1b[38;5;140m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
} as unknown as Theme
const at = (time: string) => `2026-11-20T10:${time}.000Z`
const entry = (time: string, role: string, text: string): ConversationEntry => ({
  at: at(time),
  role,
  text,
})
const call = (name: string, args: object) => `mcp__piworker__${name} ${JSON.stringify(args)}`
const command = (exitCode: number | null, output: string, extra: object = {}) =>
  JSON.stringify({
    argv: ['sh', '-c', 'npm test'],
    exitCode,
    output,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 2300,
    call: '4',
    ...extra,
  })

function render(entries: ConversationEntry[], width = 96, theme = plainTheme) {
  return new ConversationRenderer(theme).render(
    entries,
    { name: 'Implementer', active: false },
    width,
  )
}

test('tool actions pair with meaningful outcomes instead of JSON', () => {
  const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
  const lines = render([
    entry('19:28', 'assistant', call('project_edit', { path: 'infra/dns.test.ts', newText: 'x' })),
    entry('19:28', 'toolResult', JSON.stringify({ edited: 'infra/dns.test.ts', call: '3' })),
    entry('19:37', 'assistant', call('run_command', { argv: ['sh', '-c', 'npm test'] })),
    entry('19:37', 'tool', 'run_command {"argv":["sh","-c","npm test"]}'),
    entry('20:14', 'toolResult', command(1, output + '\nFAIL queue recovery\n')),
    entry('20:20', 'assistant', call('project_read', { path: 'src/worker.ts' })),
    entry(
      '20:21',
      'user',
      JSON.stringify({ content: '1: a\n2: b', fileSha256: 'f'.repeat(64), call: '5' }),
    ),
    entry('20:22', 'tool', 'run_command {"argv":["npm","run","lint"]}'),
    entry('20:23', 'toolResult', command(null, '', { timedOut: true })),
  ])
  const text = lines.join('\n')
  assert.match(text, /› Edit +infra\/dns\.test\.ts +✓ saved/)
  assert.equal(text.match(/› Run +npm test/g)?.length, 1, 'Pi execution events are not repeated')
  assert.match(text, /✗ exit 1 {2}2\.3s/)
  assert.match(text, /│ FAIL queue recovery/)
  assert.match(text, /13 earlier lines hidden, r shows raw/)
  assert.match(text, /› Read +src\/worker\.ts +✓ 2 lines \(1–2\)/)
  assert.match(text, /› Run +npm run lint +✗ timed out after 2\.3s/)

  for (const fragment of ['"argv"', '"content"', 'fileSha256', '{', 'Tool result']) {
    assert.ok(!text.includes(fragment), `${fragment} leaked into ${text}`)
  }
})

test('interleaved batches indent each child once and leave direct reads outside', () => {
  const batchTime = '2026-11-20T10:00:00Z'
  const action = (toolCallId: string, text: string, parentToolCallId?: string) => ({
    at: batchTime,
    role: 'tool',
    text,
    toolCallId,
    parentToolCallId,
  })
  const result = (toolCallId: string, text: string) => ({
    at: batchTime,
    role: 'toolResult',
    text,
    toolCallId,
  })
  const read = 'project_read {"path":"same.md"}'
  const script = 'codemode {"code":"inspect"}'
  const entries = [
    action('batch-a', script),
    action('child-a1', read, 'batch-a'),
    action('direct', read),
    action('batch-b', call('codemode', { code: 'inspect' })),
    action('child-b', 'original_read {"path":"same.md","startLine":8,"startColumn":3}', 'batch-b'),
    action('child-a2', 'project_search {"pathPrefix":"src","afterPath":"src/a"}', 'batch-a'),
    { ...result('child-a2', 'lookup rejected'), isError: true },
    result('batch-b', 'Script completed'),
    result('batch-a', 'Script completed'),
    result('direct', '{"content":"1: direct"}'),
  ]
  const rows = render(entries).filter((row) => row.includes('› '))
  assert.deepEqual(
    rows.map((row) => row.replace(/(?<=\S) +/g, ' ').trimEnd()),
    [
      '  › Codemode 2 nested calls ✗ 1 failed',
      '    › Read same.md',
      '    › Search files in src after src/a ✗ lookup rejected',
      '  › Read same.md ✓ 1 line',
      '  › Codemode 1 file ✓ done',
      '    › Original same.md:8:3',
    ],
  )

  // Without a visible parent (tail window) or identities (older transcript), keep the evidence.
  assert.match(render(entries.slice(1, 3)).join('\n'), /Read +same.md[\s\S]*Read +same.md/)
  const legacy = entries.map(({ at: time, role, text }) => ({ at: time, role, text }))
  assert.equal(render(legacy).filter((row) => row.startsWith('  › Read')).length, 2)
  assert.ok(!render(legacy).some((row) => row.startsWith('    › ')))
})

test('a codemode receipt links child IDs and retains both cancellation and script failure', () => {
  const script = { ...entry('19:28', 'tool', 'codemode {"code":"inspect"}'), toolCallId: 'batch' }
  const read = entry('19:28', 'tool', 'project_read {"path":"same.md"}')
  const receipt = {
    role: 'toolResult',
    toolName: 'codemode',
    toolCallId: 'batch',
    content: 'Script failed\nScript error:\nStop requested',
    isError: true,
    details: {
      calls: [
        { id: 'page', name: 'read', args: '{"path":"other.md","offset":12}' },
        { id: 'reference', name: 'read_reference', args: '{"name":"compiler"}' },
        { id: 'nested', name: 'project_read', args: '{}', status: 'cancelled' },
      ],
    },
  }
  const entries = [
    script,
    { ...read, toolCallId: 'nested' },
    { ...read, toolCallId: 'direct' },
    {
      ...entry('19:28', 'tool', 'read_reference {}'),
      toolCallId: 'reference',
    },
    ...messageEntries(receipt).map((message) => ({ ...message, at: at('19:29') })),
  ]
  const text = render(entries).join('\n')
  assert.match(text, /Codemode +3 nested calls +✗ 1 cancelled/)
  assert.match(text, /Stop requested/)

  // The page exists only in the receipt; the other two starts arrived in reverse order.
  const rows = text.split('\n').filter((line) => /› (Read|Reference) /.test(line))
  assert.deepEqual(
    rows.map((line) => line.replace(/(?<=\S) +/g, ' ').trimEnd()),
    [
      '    › Read other.md:12',
      '    › Reference compiler',
      '    › Read same.md ▲ cancelled',
      '  › Read same.md',
    ],
  )
})

test('loop failures show the first replay seed in the worker conversation', () => {
  const lines = render([
    entry('19:28', 'assistant', call('verify_loop', { mode: 'seeded', argv: ['node', 'test.js'] })),
    entry(
      '19:29',
      'toolResult',
      JSON.stringify({
        status: 'failed',
        completed: 7,
        requested: 10,
        snapshot: 'pinned',
        seed: 12,
      }),
    ),
  ])
  assert.match(lines.join(' '), /Verify +seeded node test.js +✗ 7\/10 · failed at seed 12/)
})

test('legacy user-role tool failures are labelled as failed calls', () => {
  const text = render([
    entry('21:52', 'assistant', call('run_command', { argv: 'npm run verify' })),
    entry('21:52', 'user', 'Unknown or invalid scoped worker tool call'),
    entry('21:53', 'assistant', 'The sandbox refuses repository-wide npm commands.'),
  ]).join('\n')
  assert.match(text, /› Run +npm run verify +✗ Unknown or invalid scoped worker tool call/)
  assert.doesNotMatch(text, /^(user|Harness)\b/m)
  assert.equal(text.match(/^Implementer ─+ 10:2\d:\d\d$/gm)?.length, 2)
})

test('turns separate speakers and highlight blockers', () => {
  const guidance = JSON.stringify({
    piWorkerGuidance: 'g1',
    userGuidance: 'Keep the backup inside the workspace.',
    instruction: 'Apply this user guidance.',
  })
  const lines = new ConversationRenderer(plainTheme).render(
    [
      entry('19:00', 'user', JSON.stringify({ assignment: 'Stockholm wallet deployment' })),
      entry('20:00', 'assistant', 'Starting with the DNS tests.'),
      entry('20:01', 'user', guidance),
      entry('20:02', 'assistant', '**Blocked:** repository gates need the host.'),
      entry(
        '20:03',
        'assistant',
        call('submit_result', {
          verdict: 'blocked',
          summary: 'Gates need the host.',
          findings: [],
          evidence: [],
          databaseImpact: false,
          hostActions: [{ capability: 'run_checks', reason: 'npm is refused in the sandbox' }],
        }),
      ),
      entry('20:03', 'toolResult', JSON.stringify({ submitted: true, call: '9' })),
    ],
    {
      name: 'Implementer',
      active: false,
      summary: { status: 'needs_attention', text: 'Host must run `npm run verify`.' },
    },
    72,
  )
  const text = lines.join('\n')
  assert.match(text, /^Assignment ─+ 10:19:00\nStockholm wallet deployment/m)
  assert.match(text, /^You ─+ 10:20:01\n┃ Keep the backup inside the workspace\.$/m)
  assert.match(text, /^▌ Blocked: repository gates need the host\.$/m)
  assert.match(text, /› Submit +blocked +✓ submitted\n +▲ Gates need the host\./)
  assert.match(text, /Needs host: run_checks — npm is refused in the sandbox/)
  assert.match(text, /^▲ Needs attention ─+\n┃ Host must run npm run verify\.$/m)
  assert.ok(!text.includes('piWorkerGuidance'))
  assert.ok(lines.every((line) => visibleWidth(line) <= 72))
})

test('worker prose renders Markdown without hidden links or terminal controls', () => {
  const capabilities = getCapabilities()
  setCapabilities({ ...capabilities, hyperlinks: true })

  try {
    const text = render([
      entry(
        '20:00',
        'assistant',
        '**Next step**: rerun the `queue` checks.\n\n' +
          '- see [the plan](https://evil.example/x) and ![chart](https://img.example/a.png)\n' +
          '[ref]: https://hidden.example\n' +
          'Escaped \x1b]8;;https://bad.example\x1b\\click\x1b]8;;\x1b\\ \x1b[2J done',
      ),
      entry('20:01', 'assistant', call('run_command', { argv: ['ls'] })),
      entry('20:02', 'toolResult', command(2, 'out \u001b]52;c;Zm9v\u0007 \u001b[31mred')),
    ]).join('\n')
    assert.match(text, /^Next step: rerun the queue checks\.$/m)
    assert.match(text, /the plan \(https:\/\/evil\.example\/x\)/)
    assert.match(text, /chart \(image: https:\/\/img\.example\/a\.png\)/)
    assert.match(text, /\[ref\]: https:\/\/hidden\.example/)
    assert.match(text, /Escaped click {2}done/)
    assert.match(text, /│ out {2}red/)
    assert.ok(
      ![String.fromCharCode(27), String.fromCharCode(7), '**Next'].some((item) =>
        text.includes(item),
      ),
    )
  } finally {
    resetCapabilitiesCache()
  }

  assert.equal(visibleLinks('`[a](b)` [a](b)'), '`[a](b)` a (b)')
  assert.equal(visibleLinks('```\n[a](b)\n```'), '```\n[a](b)\n```')
})

test('conversation stays within narrow and wide widths in colour and monochrome', () => {
  const entries = [
    entry(
      '20:00',
      'assistant',
      'A long paragraph '.repeat(20) + '\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    ),
    entry('20:01', 'assistant', call('project_edit', { path: 'a/very/long/path/'.repeat(8) })),
    entry('20:02', 'toolResult', command(1, 'x'.repeat(400))),
    entry('20:03', 'user', JSON.stringify({ userGuidance: '長い文章 café 🧪 '.repeat(10) })),
  ]

  for (const theme of [plainTheme, colorTheme]) {
    for (const width of [8, 20, 40, 72, 96]) {
      const lines = render(entries, width, theme)
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width} overflow:\n${lines.join('\n')}`,
      )
    }
  }

  assert.match(render(entries, 40).join('\n'), /› Edit +…[\w/]*path\//)
})

test('chat view keeps raw toggle, scrolling, follow and wheel input', async () => {
  const row = {
    id: 'w1',
    info: {
      role: 'implementer',
      model: 'test/model',
      task: 'Update queue',
      scope: ['design.md'],
      projectRoot: '/repo',
      workspace: '/repo',
      startedAt: at('00:00'),
      output: '/repo/out.json',
    },
    state: { status: 'running', stage: 'model', updatedAt: at('00:00') },
    active: true,
    accepting: true,
    delegatedBy: 'orchestrator',
    guidance: [],
  } as unknown as WorkerRow
  const entries = Array.from({ length: 30 }, (_, index) => [
    entry('20:00', 'assistant', call('run_command', { argv: ['echo', String(index)] })),
    entry('20:01', 'toolResult', command(0, `printed ${index}`)),
  ]).flat()
  const view = new WorkersView(
    {
      list: async () => [row],
      conversation: async () => ({ entries, truncated: false }),
      warnings: [],
      send: async () => 'Guidance queued.',
    },
    plainTheme,
    () => 24,
    () => {},
    () => {},
    false,
    false,
  )
  await view.refresh()
  view.handleInput('\r')
  await view.refresh()
  const position = () =>
    view.render(80).find((line) => /(Conversation|Raw transcript) {2}──/.test(line))
  const readable = view.render(80).join('\n')
  assert.match(readable, /test.model · effort unrecorded/)

  for (const [model, thinking, expected] of [
    ['openai-codex/gpt-6.2-astra', 'xhigh', 'Astra 6.2 · xhigh'],
    ['claude-cli/claude-fable-5-2', 'medium', 'Fable 5.2 · medium'],
    ['claude-cli/opus', 'high', 'Opus · high'],
  ] as const) {
    Object.assign(row.info, { model, thinking })
    assert.ok(view.render(80).join('\n').includes(expected))
  }

  assert.match(readable, /printed 29/)
  assert.doesNotMatch(readable, /"argv"/)
  const following = position()
  view.handleInput('\x1b[A')
  assert.notEqual(position(), following)
  view.handleInput('\x1b[F')
  assert.equal(position(), following)
  view.handleMouse({ type: 'wheel', wheelDelta: -3 } as never)
  assert.notEqual(position(), following)
  view.handleInput('r')
  assert.match(view.render(80).join('\n'), /"argv"/)
  assert.match(position() ?? '', /Raw transcript/)
  view.handleInput('r')
  assert.match(position() ?? '', /Conversation/)
  view.handleInput('g')
  assert.equal(view.composing, true)
  view.dispose()
})

test('parallel calls with no recorded IDs keep their outcomes separate', () => {
  const text = render([
    entry('20:00', 'assistant', call('project_read', { path: 'a.ts' })),
    entry('20:00', 'assistant', call('project_read', { path: 'b.ts' })),
    entry('20:01', 'toolResult', 'Unknown or invalid scoped worker tool call'),
    entry('20:02', 'toolResult', JSON.stringify({ content: '1: hello', call: '2' })),
  ]).join('\n')
  assert.match(text, /Result +✗ Unknown/)
  assert.match(text, /Result +✓ 1 line/)
  assert.doesNotMatch(text, /[ab]\.ts +[✓✗]/)
})
