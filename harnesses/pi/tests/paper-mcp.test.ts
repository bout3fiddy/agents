import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { install } from '../scripts/install.ts'
import { paperServers } from '../src/paper-mcp.ts'
import { explicitResources } from '../src/worker.ts'

test('workers register Paper Desktop unless isolation is required', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'paper-registration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { destination, wrapper } = await install(join(root, 'agent'))
  const launcher = await readFile(wrapper, 'utf8')
  assert.match(launcher, /--extension '[^']*\/paper-mcp\.ts'/)
  assert.doesNotMatch(launcher, /--no-mcp/)
  const previous = process.env
  process.env = { ...previous, PI_HARNESS_AGENT_DIR: destination, PI_HARNESS_ISOLATION: '' }
  t.after(() => {
    process.env = previous
  })
  const servers = await paperServers({ root }, true)
  const command =
    '/Applications/Paper.app/Contents/Resources/app.asar.unpacked/dist/cli-bin/darwin-arm64/paper'
  assert.deepEqual(servers, { paper: { command, args: ['mcp'] } })
  const loader = await explicitResources('Registration only.', servers)
  const registry = loader.getExtensions().runtime.mcpServers
  assert.deepEqual(
    registry.list().map(({ name }) => name),
    ['paper'],
  )
  assert.deepEqual(registry.get('paper')?.config, { command, args: ['mcp'], exposure: 'direct' })
  assert.deepEqual(await paperServers({ root }, false), {})
  assert.deepEqual(
    await paperServers(
      { root, execution: { mode: 'required-isolation', reason: 'task-policy' } },
      true,
    ),
    {},
  )
})
