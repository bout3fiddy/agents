import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freshBootstrapRoot, hostFileAllowed } from '../src/host-file-routing.ts'

test('host may finish tooling-created starter files only during fresh bootstrap', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-host-bootstrap-')))
  const allowed = (name: string, baseline: string | undefined) => {
    const path = join(root, name)
    return hostFileAllowed(
      root,
      root,
      path,
      { toolName: 'write', input: { path, content: '{}' } },
      baseline,
    )
  }

  try {
    await mkdir(join(root, '.pi'))
    await writeFile(join(root, 'AGENTS.md'), 'Follow Tiger Style.\n')
    const baseline = await freshBootstrapRoot(root)
    assert.equal(baseline, root)
    await mkdir(join(root, '.git'))

    // A README-only or manifest-only project is not fresh when a later request begins.
    for (const file of ['README.md', 'package.json']) {
      await writeFile(join(root, file), '{}\n')
      const later = await freshBootstrapRoot(root)
      assert.equal(later, undefined)
      assert.equal(await allowed('package.json', later), false)
      assert.equal(await allowed('README.md', later), false)
      await rm(join(root, file))
    }

    // Installation within the original request does not transfer the setup files to a worker.
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), '{}\n')
    await writeFile(join(root, 'package-lock.json'), '{}\n')
    assert.equal(await allowed('package.json', baseline), true)
    assert.equal(await allowed('README.md', baseline), true)
    assert.equal(await allowed('package-lock.json', baseline), false)
    assert.equal(await allowed('index.js', baseline), false)

    // A product file arriving mid-request also closes the exception.
    await writeFile(join(root, 'index.js'), 'export {}\n')
    assert.equal(await allowed('package.json', baseline), false)
    assert.equal(await allowed('README.md', baseline), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
