import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { harnessRoot } from '../src/project.ts'
import { StateStore } from '../src/state.ts'
import { captureBuild } from '../src/runtime-version.ts'
import { needsRestart } from '../src/pi-host.ts'

test('reload can change the extension but not the launcher, entry point or Pi version', () => {
  const source = '/release/'
  const pi = { version: '1.6.1', entry: '/shared/cli.js' }
  const install = { pi, source, wrapper: '/bin/pih', sourceHash: 'next', installedAt: 'next' }
  const host = {
    ...pi,
    executable: process.execPath,
    launcherSource: source,
    wrapper: install.wrapper,
  }
  assert.equal(needsRestart(source, host, install), false)

  for (const change of [
    { version: '0.9' },
    { entry: '/global/cli.js' },
    { wrapper: undefined },
    { launcherSource: '/another/release/' },
  ]) {
    assert.equal(needsRestart(source, { ...host, ...change }, install), true)
  }

  assert.equal(needsRestart('/old/extension/', host, install), true)
})

test('startup and reload receipts identify loaded code and tools', async () => {
  const { root, base } = await fixture()
  const probe = join(base, 'extension.ts')
  const source = (generation: number) =>
    `import harness from ${JSON.stringify(join(harnessRoot, 'src/extension.ts'))}\n` +
    `export default function(pi) { harness(pi); pi.on('session_start', () => ` +
    `pi.appendEntry('reload-probe', { generation: ${generation} })) }\n`
  await writeFile(probe, source(1))
  const { session, runtime } = await captureSession(
    root,
    base,
    [],
    async () => [{ type: 'text', text: 'Ready.' }],
    { extensionPaths: [probe] },
  )

  try {
    const path = join(
      new StateStore(root).directory,
      'runtime',
      `${session.sessionManager.getSessionId()}.jsonl`,
    )
    const records = async () =>
      (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const first = (await records())[0]
    assert.equal(first.version, captureBuild(harnessRoot).version)
    assert.match(first.sourceHash, /^[a-f0-9]{64}$/)
    assert.ok(first.activeTools.includes('job_start'))
    assert.ok(first.activeTools.includes('job_status'))
    assert.ok(first.activeTools.includes('job_close'))
    assert.ok(first.registeredTools.includes('job_retry'))

    // Pi creates the persisted session file after the first assistant response.
    await session.prompt('Begin the design discussion.')
    await writeFile(probe, source(2))
    await session.reload()
    const second = (await records())[1]
    assert.equal(second.reason, 'reload')
    assert.notEqual(second.loadId, first.loadId)
    assert.equal(second.sourceHash, first.sourceHash)
    const mirrored = await readFile(
      join(root, '.pi/traces/sessions', basename(session.sessionManager.getSessionFile()!)),
      'utf8',
    )
    assert.equal(mirrored.split('\n').filter((line) => line.includes('pi-harness-load')).length, 2)
    const probes = session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom' && entry.customType === 'reload-probe')
    assert.deepEqual(
      probes.map((entry) => (entry.type === 'custom' ? entry.data : undefined)),
      [{ generation: 1 }, { generation: 2 }],
    )
    await session.prompt('Continue the design discussion.')
    const timing = (
      await readFile(
        join(
          new StateStore(root).directory,
          'timing',
          `${session.sessionManager.getSessionId()}.jsonl`,
        ),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(timing.findLast((row) => row.event === 'request').runtime.loadId, second.loadId)
    assert.equal(
      session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom' && entry.customType === 'pi-harness-load')
        .length,
      2,
    )
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  }
})

test('a later source edit cannot relabel a previously captured runtime', async () => {
  const { base } = await fixture()
  const source = join(base, 'harness')

  try {
    for (const folder of ['src', 'roles', 'prompts']) {
      await mkdir(join(source, folder), { recursive: true })
    }

    await writeFile(join(source, 'package.json'), '{"version":"fixture"}')
    await writeFile(join(source, 'package-lock.json'), '{}')
    await writeFile(join(source, 'src/runtime.ts'), 'export const generation = 1\n')
    const loaded = captureBuild(source)
    const original = loaded.sourceHash
    await writeFile(join(source, 'src/runtime.ts'), 'export const generation = 2\n')
    assert.equal(loaded.sourceHash, original)
    assert.notEqual(captureBuild(source).sourceHash, original)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
