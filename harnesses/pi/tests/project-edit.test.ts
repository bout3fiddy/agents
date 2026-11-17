import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileTools } from '../src/file-tools.ts'
import { fixture } from './support.ts'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

test('focused edits preserve documents and reject unsafe targets', async () => {
  const item = await fixture()

  try {
    const original = 'Unchanged context.\n'.repeat(2500) + 'The selected value is old.\n'
    await writeFile(join(item.root, 'design.md'), original)
    const tool = fileTools(item.root, ['design.md', 'alias.md', '.env'], ['**']).find(
      (entry) => entry.name === 'project_edit',
    )!
    const edit = (path: string, oldText: string, newText: string) =>
      tool.execute(
        'edit',
        { path, oldText, newText },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      )
    await edit('design.md', 'The selected value is old.', 'The selected value is $& new.')
    const expected = original.replace(
      'The selected value is old.',
      'The selected value is $$& new.',
    )
    assert.equal(await readFile(join(item.root, 'design.md'), 'utf8'), expected)
    await assert.rejects(edit('design.md', 'The selected value is old.', 'stale'), /exactly once/)
    await assert.rejects(edit('design.md', 'Unchanged context.', 'ambiguous'), /exactly once/)
    await assert.rejects(edit('elsewhere.md', 'old', 'new'), /outside/)
    await assert.rejects(edit('../escape.md', 'old', 'new'))
    await writeFile(join(item.root, '.env'), 'SECRET=old')
    await assert.rejects(edit('.env', 'old', 'new'))
    await symlink(join(item.root, 'design.md'), join(item.root, 'alias.md'))
    await assert.rejects(edit('alias.md', 'old', 'new'))
    assert.equal(await readFile(join(item.root, 'design.md'), 'utf8'), expected)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})
