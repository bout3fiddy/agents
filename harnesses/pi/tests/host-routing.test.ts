import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import harness from '../src/extension.ts'
import { Delegations } from '../src/delegation-state.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'

test('host can make multiple contextual document edits without forced delegation', async () => {
  const item = await fixture()
  let step = 0
  const { session, runtime } = await captureSession(item.root, item.base, [harness], async () => {
    const index = step++
    return index < 5
      ? [
          {
            type: 'toolCall',
            id: `edit-${index}`,
            name: 'write',
            arguments: { path: `note-${index}.md`, content: 'Readable document.\n'.repeat(150) },
          },
        ]
      : [{ type: 'text', text: 'Updated the related documents directly.' }]
  })

  try {
    await session.prompt('Update the related documents in this fresh session.')

    for (let index = 0; index < 5; index++) {
      assert.equal(
        await readFile(join(item.root, `note-${index}.md`), 'utf8'),
        'Readable document.\n'.repeat(150),
      )
    }

    assert.equal((await new Delegations(item.store).list()).length, 0)
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
