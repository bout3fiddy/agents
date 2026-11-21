import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fixture } from './support.ts'
import { atomicJson } from '../src/state.ts'
import { harnessRoot, loadProject } from '../src/project.ts'
import { claudeArguments, parseClaudeTrace, runClaudeWorker } from '../src/claude-worker.ts'
import { loadRole } from '../src/roles.ts'

test('Claude enables web tools and records successful calls', async () => {
  for (const name of ['design-advisor', 'progress-auditor', 'performance'] as const) {
    const role = await loadRole(name)
    const args = claudeArguments(
      { ...role, tools: [...role.tools, 'Bash', 'Read', 'Agent'] },
      '/config.json',
      '/system.txt',
    )
    assert.deepEqual(args[args.indexOf('--tools') + 1]!.split(',').sort(), [
      'WebFetch',
      'WebSearch',
    ])
    assert.equal(args.includes('--max-turns'), false)
    assert.equal(args[args.indexOf('--effort') + 1], role.thinking)
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]!).maxEffortLevel, role.thinking)
  }

  const trace = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'search', name: 'WebSearch' },
          { type: 'tool_use', id: 'fetch', name: 'WebFetch' },
          { type: 'tool_use', id: 'unfinished', name: 'Unfinished' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'search', is_error: false },
          { type: 'tool_result', tool_use_id: 'fetch', is_error: true },
        ],
      },
    },
    { type: 'result', result: 'Verified the source', is_error: false },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  assert.deepEqual(parseClaudeTrace(trace).toolsUsed, ['WebSearch'])
})

test('Claude bridge gives performance scoped writes and denies product writes', async () => {
  const item = await fixture({ performance: true })
  const requestPath = join(item.base, 'request.json')
  const client = new Client({ name: 'harness-test', version: '1' })
  await mkdir(join(item.root, 'benchmarks'))
  await atomicJson(requestPath, {
    role: 'performance',
    task: 'Bridge test',
    workspace: item.root,
    project: await loadProject(item.root),
    checkpoint: await item.store.checkpoint(),
    model: 'claude-fable-5-2',
    outputPath: join(item.base, 'output.json'),
    baseline: {},
  })

  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          '--import',
          join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
          join(harnessRoot, 'src/claude-tools.ts'),
          requestPath,
        ],
        stderr: 'pipe',
      }),
    )
    const tools = await client.listTools()
    assert.ok(tools.tools.some((tool) => tool.name === 'project_write'))
    assert.ok(!tools.tools.some((tool) => tool.name === 'workflow' || tool.name === 'bash'))
    const formatTool = tools.tools.find((tool) => tool.name === 'project_format')
    assert.match(formatTool?.description ?? '', /readability-spacing/)
    const rule = await client.callTool({
      name: 'read_reference',
      arguments: { name: 'readability-spacing' },
    })
    const canonical = await readFile(join(harnessRoot, 'scripts/linting/readability.mjs'), 'utf8')
    assert.deepEqual(rule.content, [{ type: 'text', text: canonical }])
    const example = join(item.root, 'benchmarks', 'probe.ts')
    await writeFile(example, 'start()\n// Sample the result.\nfinish()\n')
    const formatted = await client.callTool({
      name: 'project_format',
      arguments: { paths: ['benchmarks/probe.ts'] },
    })
    assert.ok(!formatted.isError)
    assert.equal(await readFile(example, 'utf8'), 'start()\n\n// Sample the result.\nfinish()\n')
    const invalidTimeout = await client.callTool({
      name: 'run_command',
      arguments: { argv: ['npm', 'test'], timeoutMs: 180000 },
    })
    assert.equal(invalidTimeout.isError, true)
    assert.match(JSON.stringify(invalidTimeout.content), /timeoutMs must be <= 120000/)
    const unknown = await client.callTool({ name: 'missing_tool', arguments: {} })
    assert.equal(unknown.isError, true)
    assert.match(JSON.stringify(unknown.content), /Unknown scoped worker tool/)
    const denied = await client.callTool({
      name: 'project_write',
      arguments: { path: 'src/value.js', content: 'bad' },
    })
    assert.equal(denied.isError, true)
    const allowed = await client.callTool({
      name: 'project_write',
      arguments: { path: 'benchmarks/probe.js', content: 'export const checksum = 1\n' },
    })
    assert.ok(!allowed.isError)
    const removed = await client.callTool({
      name: 'project_delete',
      arguments: { path: 'benchmarks/probe.js' },
    })
    assert.ok(!removed.isError)
    await assert.rejects(readFile(join(item.root, 'benchmarks/probe.js')), { code: 'ENOENT' })
    const deniedDelete = await client.callTool({
      name: 'project_delete',
      arguments: { path: 'src/value.js' },
    })
    assert.equal(deniedDelete.isError, true)
    const deniedPolicy = await client.callTool({
      name: 'project_write',
      arguments: { path: '.PI/harness.json', content: '{}' },
    })
    assert.equal(deniedPolicy.isError, true)
    assert.equal(
      await readFile(join(item.root, 'src/value.js'), 'utf8'),
      'export const value = 0\n',
    )
    const traversal = await client.callTool({
      name: 'project_read',
      arguments: { path: '../outside.txt' },
    })
    assert.equal(traversal.isError, true)
    const args = claudeArguments(await loadRole('performance'), '/config.json', '/system.txt')
    assert.ok(args.includes('--dangerously-skip-permissions'))
    assert.ok(args.includes('--strict-mcp-config'))
    assert.deepEqual(args[args.indexOf('--tools') + 1]!.split(',').sort(), [
      'WebFetch',
      'WebSearch',
    ])
    assert.equal(args.includes('--max-turns'), false)
    assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  } finally {
    await client.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('a missing Claude executable reports its launch error cleanly', async () => {
  const item = await fixture()
  const previous = process.env.PI_HARNESS_CLAUDE_BIN
  process.env.PI_HARNESS_CLAUDE_BIN = join(item.base, 'missing-claude')

  try {
    await assert.rejects(
      runClaudeWorker(
        {
          role: 'progress-auditor',
          task: 'Read-only launch probe',
          workspace: item.root,
          project: await loadProject(item.root),
          checkpoint: (await item.store.checkpoint())!,
          model: 'unused',
          outputPath: join(item.base, 'output.json'),
          baseline: {},
        },
        await loadRole('progress-auditor'),
      ),
      { code: 'ENOENT' },
    )
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HARNESS_CLAUDE_BIN
    } else {
      process.env.PI_HARNESS_CLAUDE_BIN = previous
    }

    await rm(item.base, { recursive: true, force: true })
  }
})

test('Claude traces retain live output and enforce a byte budget for Unicode', async () => {
  const item = await fixture()
  const previous = process.env.PI_HARNESS_CLAUDE_BIN
  const executable = join(item.base, 'trace-producer')
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("€".repeat(6000000))\n', {
    mode: 0o755,
  })
  process.env.PI_HARNESS_CLAUDE_BIN = executable
  const outputPath = join(item.base, 'overflow.json')

  try {
    await assert.rejects(
      runClaudeWorker(
        {
          role: 'progress-auditor',
          task: 'Exercise the trace byte limit',
          workspace: item.root,
          project: await loadProject(item.root),
          checkpoint: (await item.store.checkpoint())!,
          model: 'unused',
          outputPath,
          baseline: {},
        },
        await loadRole('progress-auditor'),
      ),
      /trace exceeded the 16 MB output budget/,
    )
    const trace = await stat(`${outputPath}.claude.jsonl`)
    assert.ok(trace.size > 0 && trace.size <= 16000000)
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HARNESS_CLAUDE_BIN
    } else {
      process.env.PI_HARNESS_CLAUDE_BIN = previous
    }

    await rm(item.base, { recursive: true, force: true })
  }
})

test('only a terminal provider quota rejection carries a retry time', () => {
  const limit = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 42 } }
  const assistant = { type: 'assistant', error: 'rate_limit' }
  const failed = { type: 'result', is_error: true }
  const retry = (...rows: object[]) =>
    parseClaudeTrace(rows.map((r) => JSON.stringify(r)).join('\n')).retryAt
  assert.equal(retry(limit, assistant, failed), 42000)
  assert.equal(retry(limit, { type: 'assistant' }, failed), undefined)
  assert.equal(retry(limit, assistant, { type: 'result', is_error: false }), undefined)
  assert.equal(
    retry(
      limit,
      { ...limit, rate_limit_info: { status: 'allowed_warning', resetsAt: 42 } },
      assistant,
      failed,
    ),
    undefined,
  )
})
