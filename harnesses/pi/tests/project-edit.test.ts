import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileTools } from '../src/file-tools.ts'
import { captureSession } from './session-support.ts'
import { fixture, hashes } from './support.ts'
import { assignment } from '../src/worker-tools.ts'
import { digest, maxFileBytes } from '../src/paths.ts'
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

test('Pi tool batches retain each same-file edit in order', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const file = join(item.root, 'sample.txt')
  await writeFile(file, 'one\ntwo\nthree\n')
  const edit = fileTools(item.root, ['sample.txt'], ['**']).find(
    (tool) => tool.name === 'project_edit',
  )!
  let turns = 0
  const { session } = await captureSession(
    item.root,
    item.base,
    [(pi) => pi.registerTool(edit)],
    async () =>
      ++turns === 1
        ? ['one', 'two', 'three'].map((oldText, i) => ({
            type: 'toolCall' as const,
            id: 'change' + i,
            name: edit.name,
            arguments: { path: 'sample.txt', oldText, newText: oldText.toUpperCase() },
          }))
        : [{ type: 'text', text: 'Done.' }],
  )
  t.after(() => session.dispose())
  const activity: string[] = []
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      activity.push(event.toolCallId + (event.type === 'tool_execution_start' ? ':start' : ':end'))
    }
  })
  await session.prompt('Apply the three exact replacements.')
  assert.equal(await readFile(file, 'utf8'), 'ONE\nTWO\nTHREE\n')
  assert.deepEqual(activity, [
    'change0:start',
    'change0:end',
    'change1:start',
    'change1:end',
    'change2:start',
    'change2:end',
  ])
})

test('a multi-edit validates the entire sequence before writing', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const file = join(item.root, 'sample.txt')
  await writeFile(file, 'one\ntwo\ntwo\n')
  const edit = fileTools(item.root, ['sample.txt'], ['**']).find(
    (tool) => tool.name === 'project_edit',
  )!
  const apply = (additionalEdits: { oldText: string; newText: string }[]) =>
    edit.execute(
      'batch',
      { path: 'sample.txt', oldText: 'one', newText: 'first', additionalEdits },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    )
  await assert.rejects(apply([{ oldText: 'two', newText: 'bad' }]), /Edit 2 is ambiguous/)
  await assert.rejects(apply([{ oldText: 'absent', newText: 'bad' }]), /Edit 2 is missing/)
  assert.equal(await readFile(file, 'utf8'), 'one\ntwo\ntwo\n')
  await apply([
    { oldText: 'first', newText: '$& FIRST' },
    { oldText: 'two\ntwo', newText: 'second' },
  ])
  assert.equal(await readFile(file, 'utf8'), '$& FIRST\nsecond\n')
})

test('edits refuse to retain a file that the snapshot cannot read', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const file = join(item.root, 'large.txt')
  const original = 'x'.repeat(maxFileBytes - 2) + 'AB'
  await writeFile(file, original)
  const edit = fileTools(item.root, ['large.txt'], ['**']).find((x) => x.name === 'project_edit')!
  await assert.rejects(
    edit.execute(
      'edit',
      { path: 'large.txt', oldText: 'AB', newText: '€' },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    ),
    /snapshot size limit/,
  )
  assert.equal(await readFile(file, 'utf8'), original)
})

test('bounded reads can resume on a line or within a long Unicode line', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const file = join(item.root, 'sample.txt')
  const read = fileTools(item.root).find((tool) => tool.name === 'project_read')!
  const page = async (startLine = 1, startColumn = 1) => {
    const result = await read.execute(
      'read',
      { path: 'sample.txt', startLine, startColumn },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    )
    return JSON.parse((result.content[0] as { text: string }).text)
  }
  const long = 'x'.repeat(23996) + '🌿tail'
  await writeFile(file, 'first\n' + long + '\nlast')
  const first = await page()
  assert.equal(first.fileSha256, digest(await readFile(file)))
  assert.equal(first.totalLines, 3)
  assert.equal(first.content, '1: first')
  assert.equal(first.nextStartLine, 2)
  const second = await page(first.nextStartLine)
  assert.equal(second.content, '2: ' + 'x'.repeat(23996))
  assert.equal(second.fileSha256, first.fileSha256)
  assert.equal(second.nextStartLine, 2)
  const third = await page(second.nextStartLine, second.nextStartColumn)
  assert.equal(third.content, '2: 🌿tail\n3: last')
  assert.equal(third.nextStartLine, undefined)
})

test('worker folder instructions can be recovered and changes are always delivered', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const rules = join(item.root, 'AGENTS.md')
  await writeFile(rules, 'First rules')
  const tools = fileTools(item.root, ['note.txt'], ['**'])
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name)!
    const result = await tool.execute('id', args, undefined, undefined, {} as ExtensionToolContext)
    return JSON.parse((result.content[0] as { text: string }).text)
  }
  await writeFile(join(item.root, 'note.txt'), 'text')
  const read = (reuseInstructions = false) =>
    invoke('project_read', {
      path: 'note.txt',
      reuseInstructions,
    })
  assert.match((await read(true)).instructions, /First rules/)
  assert.equal((await read(true)).instructionsUnchanged, true)
  assert.equal(
    (await invoke('project_write', { path: 'note.txt', content: 'new' })).instructionsUnchanged,
    true,
  )
  assert.match((await read()).instructions, /First rules/)
  await writeFile(rules, 'Revised rules')
  assert.match((await read(true)).instructions, /Revised rules/)
})

test('worker assignments identify added, deleted and edited paths', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  await writeFile(join(item.root, 'removed'), '')
  const baseline = await hashes(item.root)
  await rm(join(item.root, 'removed'))
  await writeFile(join(item.root, 'added'), '')
  await writeFile(join(item.root, 'src/value.js'), 'new')
  const payload = await assignment({
    task: 'Review changes',
    role: 'reviewer',
    workspace: item.root,
    outputPath: item.base,
    checkpoint: (await item.store.checkpoint())!,
    baseline,
    model: 'test',
    project: { root: item.root, checks: [], instrumentationPaths: [], databasePaths: [] },
  })
  assert.deepEqual(payload.changedFiles, ['added', 'removed', 'src/value.js'])
  assert.deepEqual(payload.originalPaths, Object.keys(baseline))
  assert.equal('originalFileHashes' in payload, false)
})

test('large project paths are available through paginated listings', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const names = Array.from({ length: 105 }, (_, i) => 'src/item-' + String(i).padStart(3, '0'))
  await Promise.all(names.map((name) => writeFile(join(item.root, name), '')))
  const baseline = await hashes(item.root)
  const payload = await assignment({
    task: 'Inspect',
    role: 'reviewer',
    workspace: item.root,
    outputPath: item.base,
    checkpoint: (await item.store.checkpoint())!,
    baseline,
    model: 'test',
    changedFiles: [],
    project: { root: item.root, checks: [], instrumentationPaths: [], databasePaths: [] },
  })
  assert.equal(payload.originalPaths, undefined)
  const search = fileTools(item.root).find((tool) => tool.name === 'project_search')!
  const page = async (afterPath?: string) => {
    const result = await search.execute(
      'list',
      { pathPrefix: 'src/item-', afterPath },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    )
    return JSON.parse((result.content[0] as { text: string }).text)
  }
  const first = await page()
  assert.equal(first.matches.length, 100)
  const second = await page(first.nextAfterPath)
  assert.deepEqual([...first.matches, ...second.matches], names)
  assert.equal(second.nextAfterPath, undefined)
  await assert.rejects(page('missing'), /cursor/)
})
