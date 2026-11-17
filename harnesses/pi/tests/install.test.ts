import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../scripts/install.ts'

test('installer backs up only Pi assets and preserves auth and provider choice', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-install-'))
  const agentDir = join(base, 'agent')
  await mkdir(join(agentDir, 'skills'), { recursive: true })
  await writeFile(join(agentDir, 'skills/old.md'), 'old skill')
  await writeFile(join(agentDir, 'auth.json'), 'fake-credential-sentinel')
  await writeFile(join(agentDir, 'AGENTS.md'), 'old instructions')
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'example', defaultModel: 'chosen', theme: 'dark' }),
  )

  try {
    const result = await install(agentDir)
    assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), 'fake-credential-sentinel')
    assert.equal(await readFile(join(result.backup, 'AGENTS.md'), 'utf8'), 'old instructions')
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(settings.defaultModel, 'chosen')
    assert.equal(settings.theme, 'dark')
    assert.ok(settings.defaultTools.includes('bash'))
    assert.ok(settings.defaultTools.includes('write'))
    assert.ok(settings.defaultTools.includes('consult_design'))
    assert.match(await readFile(result.wrapper, 'utf8'), /--no-extensions/)
    assert.match(await readFile(result.wrapper, 'utf8'), /--session-dir.*\.pi\/traces\/sessions/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
