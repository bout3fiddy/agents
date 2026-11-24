import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { furnishTigerStyle } from '../src/tiger-style.ts'

test('concurrent host starts share the Git root and retain customized instructions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tiger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const sub = join(root, 'src')
  await mkdir(sub)
  const agents = join(root, 'AGENTS.md')
  await writeFile(agents, 'Keep my instructions.')
  const [prompt] = await Promise.all([furnishTigerStyle(sub), furnishTigerStyle(root)])
  assert.match(prompt, /Before product implementation, inspect actual instructions/)
  assert.equal(
    await readFile(agents, 'utf8'),
    'Keep my instructions.\n\nFollow [Tiger Style](TIGER_STYLE.md).\n',
  )
  const guide = join(root, 'TIGER_STYLE.md')
  const fresh = await readFile(guide, 'utf8')
  assert.match(fresh, /Customization pending/)
  const customized = fresh.replace('Customization pending', 'Customized: build with make')
  await writeFile(guide, customized)
  await furnishTigerStyle(sub)
  assert.equal(await readFile(guide, 'utf8'), customized)
  await rm(guide)
  await furnishTigerStyle(sub)
  assert.equal(await readFile(guide, 'utf8'), fresh)
})

test('non-Git bootstrap refuses conflicts, symlinks and nonregular files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tiger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guide = join(root, 'TIGER_STYLE.md')
  await writeFile(guide, 'user notes')
  await assert.rejects(furnishTigerStyle(root), /Conflicting/)
  assert.equal(await readFile(guide, 'utf8'), 'user notes')
  await rm(guide)
  const agents = join(root, 'AGENTS.md')
  await symlink(guide, agents)
  await assert.rejects(furnishTigerStyle(root), { code: 'ELOOP' })
  await rm(agents)
  await mkdir(agents)
  await assert.rejects(furnishTigerStyle(root), /Unsafe/)
  await rm(agents, { recursive: true })
  await furnishTigerStyle(root)
  assert.match(await readFile(agents, 'utf8'), /TIGER_STYLE.md/)
})

test('unsafe and oversized bootstrap inputs fail before any documents are created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tiger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'unrelated')
  await writeFile(target, 'retain')

  for (const name of ['TIGER_STYLE.md', 'TIGER_STYLE_LICENSE']) {
    const path = join(root, name)
    await symlink(target, path)
    await assert.rejects(furnishTigerStyle(root), { code: 'ELOOP' })
    await rm(path)
    await mkdir(path)
    await assert.rejects(furnishTigerStyle(root), /Unsafe/)
    await rm(path, { recursive: true })
  }

  const agents = join(root, 'AGENTS.md')
  const oversized = 'x'.repeat(256 * 1024 + 1)
  await writeFile(agents, oversized)
  await assert.rejects(furnishTigerStyle(root), /oversized/)
  assert.equal(await readFile(agents, 'utf8'), oversized)
  assert.equal(await readFile(target, 'utf8'), 'retain')

  for (const name of ['TIGER_STYLE.md', 'TIGER_STYLE_LICENSE']) {
    await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' })
  }

  await rm(agents)
  await furnishTigerStyle(root)
  assert.match(await readFile(agents, 'utf8'), /TIGER_STYLE.md/)
})
