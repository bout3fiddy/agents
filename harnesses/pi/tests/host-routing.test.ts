import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import harness from '../src/extension.ts'
import { Delegations } from '../src/delegation-state.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'

test('host routes product changes and preserves setup and decision capture', async () => {
  const item = await fixture()
  const read = (path: string) => readFile(join(item.root, path), 'utf8')
  const original = await read('src/value.js')
  const document = '# Product\n\n\nExisting contract.\n'
  await writeFile(join(item.root, 'README.md'), document)
  await symlink('src/alias.js', join(item.root, 'design.md'))
  const blocked = [
    ['write', { path: 'src/new', content: 'feature' }],
    ['edit', { path: 'src/value.js', edits: [{ oldText: '0', newText: '1' }] }],
    ['write', { path: 'README.md', content: 'repair' }],
    ['write', { path: 'design.md', content: 'alias' }],
    ['document_check', { paths: ['README.md'], format: true }],
    ['write', { path: 'design/design.md', content: 'x'.repeat(4097) }],
  ] as const
  const calls = [
    ...blocked,
    ['write', { path: '.gitignore', content: 'node_modules/\n' }],
    [
      'edit',
      {
        path: 'TIGER_STYLE.md',
        edits: [{ oldText: 'Customization pending.', newText: 'Custom.' }],
      },
    ],
    ['write', { path: 'design/design.md', content: 'Keep capacity bounded.\n' }],
    ['write', { path: '.pi/traces/scratch/probe.js', content: 'probe' }],
  ] as const
  let step = 0
  const { session, runtime } = await captureSession(item.root, item.base, [harness], async () => {
    const call = calls[step++]
    return call
      ? [{ type: 'toolCall', id: `route-${step}`, name: call[0], arguments: call[1] }]
      : [{ type: 'text', text: 'Finished checking host routing.' }]
  })

  try {
    await session.prompt('Exercise file routing, including attempted product repairs.')
    await assert.rejects(read('src/new'), { code: 'ENOENT' })
    assert.equal(await read('src/value.js'), original)
    assert.equal(await read('README.md'), document)
    await assert.rejects(read('src/alias.js'), { code: 'ENOENT' })
    const results = session.state.messages.filter((message) => message.role === 'toolResult')
    assert.equal(results.length, calls.length)

    for (const result of results.slice(0, blocked.length)) {
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result.content), /delegate_task/)
    }

    assert.match(await read('TIGER_STYLE.md'), /Custom\. The host owns/)
    assert.equal(await read('.gitignore'), 'node_modules/\n')
    assert.equal(await read('design/design.md'), 'Keep capacity bounded.\n')
    assert.equal(await read('.pi/traces/scratch/probe.js'), 'probe')
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('host-only capabilities reject incompatible delegation before creating a task', async () => {
  const item = await fixture()
  let launches = 0

  try {
    await assert.rejects(
      new Delegations(item.store).start(
        {
          task: 'Install dependencies and publish the repository',
          context: '',
          kind: 'maintenance',
          writePaths: ['package.json'],
          requires: ['dependencies', 'git'],
        },
        { session: 'session', model: 'fixture' },
        async () => {
          launches++
        },
      ),
      /Host capabilities/,
    )
    assert.equal(launches, 0)
    assert.equal((await new Delegations(item.store).list()).length, 0)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})
