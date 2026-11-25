import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRole } from '../src/roles.ts'
import { install } from '../scripts/install.ts'

test('fresh installer and default Codex delegates select Astra medium', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-defaults-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const { destination } = await install(join(base, 'agent'))
  const settings = JSON.parse(await readFile(join(destination, 'settings.json'), 'utf8'))
  const model = `${settings.defaultProvider}/${settings.defaultModel}`
  assert.deepEqual([model, settings.defaultThinkingLevel], ['openai-codex/gpt-6.2-astra', 'medium'])

  for (const name of [
    'task-coordinator',
    'branch-orchestrator',
    'task-worker',
    'implementer',
  ] as const) {
    const role = await loadRole(name)
    assert.deepEqual([role.model, role.thinking], [model, 'medium'])
  }

  assert.equal((await loadRole('orchestrator')).model, 'inherit')
})

test('installer backs up only Pi assets and preserves auth and provider choice', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-install-'))
  const agentDir = join(base, 'agent')
  await mkdir(join(agentDir, 'skills'), { recursive: true })
  await writeFile(join(agentDir, 'skills/old.md'), 'old skill')
  await writeFile(join(agentDir, 'auth.json'), 'fake-credential-sentinel')
  await writeFile(join(agentDir, 'AGENTS.md'), 'old instructions')
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'example',
      defaultModel: 'chosen',
      defaultThinkingLevel: 'high',
      theme: 'dark',
    }),
  )

  try {
    const result = await install(agentDir)
    assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), 'fake-credential-sentinel')
    assert.equal(await readFile(join(result.backup, 'AGENTS.md'), 'utf8'), 'old instructions')
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(settings.defaultModel, 'chosen')
    assert.equal(settings.defaultThinkingLevel, 'high')
    assert.equal(settings.theme, 'dark')
    assert.ok(settings.defaultTools.includes('bash'))
    assert.ok(settings.defaultTools.includes('write'))
    assert.ok(settings.defaultTools.includes('consult_design'))
    const launcher = await readFile(result.wrapper, 'utf8')
    const update = spawnSync(result.wrapper, ['update', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--throw-deprecation' },
      timeout: 15_000,
    })
    assert.equal(update.error, undefined)
    assert.equal(update.status, 0, update.stderr)
    assert.match(update.stdout, /Usage: pi-harness update/)
    assert.doesNotMatch(update.stderr, /DEP0205|DeprecationWarning/)
    assert.match(launcher, /--no-extensions/)
    assert.doesNotMatch(launcher, /--tools(?:\s|$)/)
    assert.match(await readFile(result.wrapper, 'utf8'), /--session-dir.*\.pi\/traces\/sessions/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
