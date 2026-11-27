import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fixture } from './support.ts'
import { runDesignAdvice } from '../src/design-advice.ts'
import type { ModelRoute } from '../src/contracts.ts'
import { workerDirectory, type LiveWorkerInfo } from '../src/worker-live.ts'
import { readProgress } from '../src/progress.ts'
import { atomicJson } from '../src/state.ts'
import { harnessRoot, loadProject } from '../src/project.ts'
import { claudeArguments, parseClaudeTrace, runClaudeWorker } from '../src/claude-worker.ts'
import { loadRole } from '../src/roles.ts'

test('Claude enables web tools and records successful calls', async () => {
  for (const name of ['design-advisor', 'performance'] as const) {
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
    checkpoint: item.checkpoint,
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
    const loop = await client.callTool({
      name: 'verify_loop',
      arguments: {
        mode: 'seeded',
        argv: ['node', '-e', 'process.exit(+process.argv[1])', '{seed}'],
        firstSeed: 0,
        count: 2,
      },
    })
    assert.equal(loop.isError, true)
    assert.match(JSON.stringify(loop.content), /Command exited 1/)
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
          role: 'performance',
          task: 'Read-only launch probe',
          workspace: item.root,
          project: await loadProject(item.root),
          checkpoint: item.checkpoint,
          model: 'unused',
          outputPath: join(item.base, 'output.json'),
          baseline: {},
        },
        await loadRole('performance'),
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

test('a Claude run that ends without submitting gets one follow-up run to submit', async () => {
  const item = await fixture()
  const previous = process.env.PI_HARNESS_CLAUDE_BIN
  const executable = join(item.base, 'unsubmitting-claude')
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('fs')",
    'const args = process.argv.slice(2)',
    'const option = (name) => args[args.indexOf(name) + 1]',
    "const config = JSON.parse(fs.readFileSync(option('--mcp-config'), 'utf8'))",
    'const attempt = config.mcpServers.piworker.args.at(-1)',
    "const prompt = fs.readFileSync(option('--system-prompt-file'), 'utf8')",
    "if (attempt.endsWith('.submit') && prompt.includes('The rotation code is written')) {",
    '  const result = { verdict: "pass", summary: "Submitted retained work", findings: [],',
    '    databaseImpact: false, evidence: ["follow-up"] }',
    "  fs.writeFileSync(attempt + '.tools.json', JSON.stringify({ commands: [], result }))",
    '}',
    "const message = 'The rotation code is written.'",
    "console.log(JSON.stringify({ type: 'result', is_error: false, result: message }))",
  ].join('\n')
  await writeFile(executable, script + '\n', { mode: 0o755 })
  process.env.PI_HARNESS_CLAUDE_BIN = executable
  const outputPath = join(item.base, 'unsubmitted.json')

  try {
    const evidence = await runClaudeWorker(
      {
        role: 'performance',
        task: 'Finish and report',
        workspace: item.root,
        project: await loadProject(item.root),
        checkpoint: item.checkpoint,
        model: 'unused',
        outputPath,
        baseline: {},
      },
      await loadRole('performance'),
    )
    assert.equal(evidence.result.summary, 'Submitted retained work')
    await stat(`${outputPath}.claude.jsonl`)
    await stat(`${outputPath}.submit.claude.jsonl`)
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HARNESS_CLAUDE_BIN
    } else {
      process.env.PI_HARNESS_CLAUDE_BIN = previous
    }

    await rm(item.base, { recursive: true, force: true })
  }
})

test('consultation confirms quota and worker attributes the shared fallback', async (t) => {
  const item = await fixture()
  const previous = {
    bin: process.env.PI_HARNESS_CLAUDE_BIN,
    agent: process.env.PI_CODING_AGENT_DIR,
  }
  t.after(async () => {
    if (previous.bin === undefined) {
      delete process.env.PI_HARNESS_CLAUDE_BIN
    } else {
      process.env.PI_HARNESS_CLAUDE_BIN = previous.bin
    }

    if (previous.agent === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous.agent
    }

    await rm(item.base, { recursive: true, force: true })
  })
  const executable = join(item.base, 'quota-claude')
  const resetSeconds = Math.floor(Date.now() / 1000) + 3600
  const retryAt = resetSeconds * 1000
  await writeFile(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs')",
      'const option = (key) => process.argv[process.argv.indexOf(key) + 1]',
      'const log = (row) => console.log(JSON.stringify(row))',
      "if (option('--model') === 'claude-fable-5-2') {",
      `  const limit = {status:'rejected', resetsAt:${resetSeconds}}`,
      "  log({type:'rate_limit_event', rate_limit_info:limit})",
      "  log({type:'assistant', error:'rate_limit'})",
      "  log({type:'result', is_error:true})",
      "} else if (option('--model') === 'opus') {",
      "  const config = JSON.parse(fs.readFileSync(option('--mcp-config')))",
      '  const attempt = config.mcpServers.piworker?.args.at(-1)',
      "  const result = {verdict:'pass', summary:'done', findings:[], databaseImpact:false,",
      "    evidence:['fixture']}",
      '  const submission = JSON.stringify({result, commands:[]})',
      "  if (attempt) fs.writeFileSync(attempt + '.tools.json', submission)",
      "  log({type:'result', result:'advice', num_turns:1, modelUsage:{'claude-opus-5-5':{}}})",
      '}',
    ].join('\n'),
    { mode: 0o755 },
  )
  process.env.PI_HARNESS_CLAUDE_BIN = executable
  process.env.PI_CODING_AGENT_DIR = item.base
  const routes: ModelRoute[] = []
  const advice = await runDesignAdvice(
    '{}',
    new AbortController().signal,
    undefined,
    'high',
    async (route) => {
      routes.push(route)
    },
  )
  assert.deepEqual(
    routes.map((route) => route.actualModel),
    ['claude-fable-5-2', 'opus'],
  )
  assert.equal(advice.actualModel, 'claude-opus-5-5')
  assert.equal(advice.fallbackReason, 'quota-confirmed')
  assert.equal(advice.retryAt, retryAt)
  const outputPath = join(item.base, 'cached.json')
  const evidence = await runClaudeWorker(
    {
      role: 'implementer',
      implementerModel: 'fable',
      thinking: 'high',
      task: 'Compare',
      workspace: item.root,
      project: await loadProject(item.root),
      checkpoint: { ...item.checkpoint, writePaths: [] },
      baseline: {},
      model: 'unused',
      outputPath,
    },
    await loadRole('implementer', 'high', 'fable'),
  )
  const directory = workerDirectory(item.root, evidence.liveWorkerId!)
  const info: LiveWorkerInfo = JSON.parse(await readFile(join(directory, 'info.json'), 'utf8'))

  for (const record of [info, evidence, await readProgress(outputPath)]) {
    assert.ok(record)
    assert.equal(record.requestedModel, 'claude-fable-5-2')
    assert.equal(record.actualModel, 'claude-opus-5-5')
    assert.equal(record.fallbackReason, 'quota-cached')
    assert.equal(record.confirmedAt, advice.confirmedAt)
    assert.equal(record.retryAt, retryAt)
  }

  assert.deepEqual(info.scope, [])
  assert.equal(info.thinking, 'high')
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
          role: 'performance',
          task: 'Exercise the trace byte limit',
          workspace: item.root,
          project: await loadProject(item.root),
          checkpoint: item.checkpoint,
          model: 'unused',
          outputPath,
          baseline: {},
        },
        await loadRole('performance'),
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
