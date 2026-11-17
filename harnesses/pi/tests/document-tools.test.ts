import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { checkDocuments } from '../src/document-tools.ts'
import { fixture } from './support.ts'

test('document exclusions preserve bytes and retain line width checks', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(root, 'design'))
  await writeFile(join(root, '.prettierignore'), '/design/**\n!/design/included.md\n')
  const source = '# Design\n\n\nAccepted.\n'
  const excluded = join(root, 'design/excluded.md')
  const included = join(root, 'design/included.md')
  await writeFile(excluded, source)
  await writeFile(included, source)
  const paths = ['design/excluded.md', 'design/included.md']
  const checked = await checkDocuments(root, paths, false)
  assert.deepEqual(checked.failures, ['design/included.md: formatting required'])
  assert.deepEqual(checked.formattingSkipped, ['design/excluded.md'])
  const formatted = await checkDocuments(root, paths, true)
  assert.equal(formatted.status, 'passed')
  assert.deepEqual(formatted.changed, ['design/included.md'])
  assert.equal(await readFile(excluded, 'utf8'), source)
  assert.equal(await readFile(included, 'utf8'), '# Design\n\nAccepted.\n')
  await writeFile(excluded, 'x'.repeat(101) + '\n')
  const overlong = await checkDocuments(root, ['design/excluded.md'], true)
  assert.deepEqual(overlong.failures, ['design/excluded.md:1: line exceeds 100 columns'])
  assert.deepEqual(overlong.changed, [])
  assert.equal(await readFile(excluded, 'utf8'), 'x'.repeat(101) + '\n')
})

test('format exclusions preserve configuration and path isolation', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  await writeFile(join(root, '.prettierrc.mjs'), 'throw new Error("Project code executed")\n')
  await writeFile(join(root, '.prettierignore'), '*.md\n')
  const source = '# Note\n\n\nPreserved.\n'
  await writeFile(join(root, 'note.md'), source)
  assert.equal((await checkDocuments(root, ['note.md'], true)).status, 'passed')
  await symlink(join(root, 'note.md'), join(root, 'link.md'))
  await assert.rejects(checkDocuments(root, ['note.md', 'link.md'], true), /Symbolic links/)
  await assert.rejects(checkDocuments(root, ['note.md', '../private.md'], true), /traversal/)
  assert.equal(await readFile(join(root, 'note.md'), 'utf8'), source)
  await rm(join(root, '.prettierignore'))
  assert.equal((await checkDocuments(root, ['note.md'], false)).status, 'failed')
})

test('document checks reject linked or oversized ignore policy before edits', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = '# Note\n\n\nPreserved.\n'
  await writeFile(join(root, 'note.md'), source)
  await writeFile(join(base, 'outside-ignore'), '*.md\n')
  const ignorePath = join(root, '.prettierignore')
  await symlink(join(base, 'outside-ignore'), ignorePath)
  await assert.rejects(checkDocuments(root, ['note.md'], true), /Symbolic links/)
  await rm(ignorePath)
  await writeFile(ignorePath, '#'.repeat(2_000_001))
  await assert.rejects(checkDocuments(root, ['note.md'], true), /read limit/)
  assert.equal(await readFile(join(root, 'note.md'), 'utf8'), source)
})
