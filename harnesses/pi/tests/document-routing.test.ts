import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import { documentShellWrite, registerDocumentRouting } from '../src/document-routing.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { registerDocumentTools } from '../src/document-tools.ts'

for (const kind of ['large', 'multiple', 'repeated', 'late', 'shell', 'format'] as const) {
  test(`lengthy document ${kind} work is routed without a user delegation request`, async () => {
    const { root, base } = await fixture()
    await writeFile(join(root, 'one.md'), '# Existing\n')
    let task = ''
    let step = 0
    let blocks = 0
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerDelegation(pi, async (request) => {
            task = request.task
          })
          registerDocumentRouting(pi)
          registerDocumentTools(pi)
        },
      ],
      async (context) => {
        const last = context.messages.at(-1)

        if (last?.role === 'toolResult' && last.isError) {
          blocks++
          assert.match(JSON.stringify(last.content), /delegate_task/)
          return [
            {
              type: 'toolCall',
              id: 'delegate',
              name: 'delegate_task',
              arguments: {
                task: 'Record the settled choice in the affected documents',
                context: 'Keep options open',
                kind: 'documents',
                writePaths: ['one.md', 'two.md'],
              },
            },
          ]
        }

        if (task) {
          return [
            { type: 'text', text: 'The update is running. Which recovery window do you prefer?' },
          ]
        }

        const index = step++

        if (kind === 'late' && index < 4) {
          return [
            { type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: 'one.md' } },
          ]
        }

        if (kind === 'shell') {
          return [
            {
              type: 'toolCall',
              id: 'shell',
              name: 'bash',
              arguments: {
                command:
                  'python3 -c "from pathlib import Path; ' +
                  "Path('one.md').write_text('rewritten')\"",
              },
            },
          ]
        }

        if (kind === 'format') {
          return [
            {
              type: 'toolCall',
              id: 'format',
              name: 'document_check',
              arguments: { paths: ['one.md', 'two.md'], format: true },
            },
          ]
        }

        const calls = [
          {
            type: 'toolCall' as const,
            id: `write-${index}`,
            name: 'write',
            arguments: {
              path: 'one.md',
              content: kind === 'large' ? 'x'.repeat(2001) : '# Small\n',
            },
          },
        ]

        if (kind === 'multiple') {
          calls.push({
            ...calls[0]!,
            id: 'other',
            arguments: { path: 'two.md', content: '# Small\n' },
          })
        }

        return calls
      },
    )

    try {
      await session.prompt('Record the settled choice in the design and continue the quiz.')
      assert.equal(blocks, 1)
      assert.ok(task)
      assert.equal(
        await readFile(join(root, 'one.md'), 'utf8'),
        kind === 'repeated' ? '# Small\n' : '# Existing\n',
      )
      await assert.rejects(readFile(join(root, 'two.md')), { code: 'ENOENT' })
    } finally {
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    }
  })
}

test('a small direct correction remains available and shell reads remain available', async () => {
  const { root, base } = await fixture()
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [registerDocumentRouting],
    async () =>
      step++ === 0
        ? [
            {
              type: 'toolCall',
              id: 'small',
              name: 'write',
              arguments: { path: 'one.md', content: '# Corrected\n' },
            },
          ]
        : [{ type: 'text', text: 'Corrected.' }],
  )

  try {
    await session.prompt('Fix the heading in one.md.')
    assert.equal(await readFile(join(root, 'one.md'), 'utf8'), '# Corrected\n')
    assert.equal(documentShellWrite('rg -n "decision" design/one.md; cat design/two.md'), false)
    assert.equal(documentShellWrite('sed -n "1,20p" design/one.md'), false)
    assert.equal(documentShellWrite('cat > design/one.md <<EOF\nreplacement\nEOF'), true)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  }
})
