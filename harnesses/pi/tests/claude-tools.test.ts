import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fixture } from './support.ts'
import { atomicJson } from '../src/state.ts'
import { harnessRoot, loadProject } from '../src/project.ts'
import { claudeArguments, runClaudeWorker } from '../src/claude-worker.ts'
import { loadRole } from '../src/roles.ts'

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
    assert.equal(args[args.indexOf('--tools') + 1], '')
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
          role: 'reviewer',
          task: 'Read-only launch probe',
          workspace: item.root,
          project: await loadProject(item.root),
          checkpoint: (await item.store.checkpoint())!,
          model: 'unused',
          outputPath: join(item.base, 'output.json'),
          baseline: {},
        },
        await loadRole('reviewer'),
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
