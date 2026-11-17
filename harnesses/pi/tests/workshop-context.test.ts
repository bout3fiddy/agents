import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { registerWorkshopContext, workshopContextEdits } from '../src/workshop-context.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import { checkDocuments } from '../src/document-tools.ts'
import { registerTiming } from '../src/timing.ts'
import { StateStore } from '../src/state.ts'

test('payloads shrink while decisions, failures and raw traces survive', async () => {
  const item = await fixture()
  await writeFile(join(item.root, 'large.md'), 'ORIGINAL_FILE_SENTINEL\n' + 'detail '.repeat(7000))
  await writeFile(
    join(item.root, 'current-policy.md'),
    'prefix '.repeat(1800) + 'CURRENT_UNCHANGED_POLICY_MARKER' + 'suffix '.repeat(1800),
  )
  let step = 0
  const payloads: string[] = []
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [registerWorkshopContext, registerTiming],
    async (context) => {
      payloads.push(JSON.stringify(context))
      step++

      if (step === 1) {
        return [
          { type: 'toolCall', id: 'large-read', name: 'read', arguments: { path: 'large.md' } },
          {
            type: 'toolCall',
            id: 'current-read',
            name: 'read',
            arguments: { path: 'current-policy.md' },
          },
        ]
      }

      if (step === 2) {
        return [
          { type: 'text', text: 'OPEN_QUESTION_MARKER and CHOSEN_DECISION_MARKER' },
          {
            type: 'toolCall',
            id: 'large-write',
            name: 'write',
            arguments: {
              path: 'large.md',
              content: '# Copy\n' + 'OUTPUT_PAYLOAD 😀 '.repeat(3000),
            },
          },
        ]
      }

      if (step === 3) {
        return [
          {
            type: 'toolCall',
            id: 'malformed',
            name: 'edit',
            arguments: { path: 'large.md', edits: [null, { old_text: 'invalid' }] },
          },
        ]
      }

      if (step <= 7) {
        return [
          {
            type: 'toolCall',
            id: `read-${step}`,
            name: 'read',
            arguments: { path: 'missing-file.md' },
          },
        ]
      }

      return [{ type: 'text', text: 'Done' }]
    },
  )

  try {
    await session.prompt('EXACT_USER_CONSTRAINT_MARKER; retain the open questions')
    await session.waitForIdle()
    assert.equal(step, 8)
    const compacted = payloads.at(-1)!
    assert.match(compacted, /EXACT_USER_CONSTRAINT_MARKER/)
    assert.match(compacted, /OPEN_QUESTION_MARKER/)
    assert.match(compacted, /CHOSEN_DECISION_MARKER/)
    assert.match(compacted, /CURRENT_UNCHANGED_POLICY_MARKER/)
    assert.match(compacted, /ENOENT/)
    assert.ok(compacted.length < payloads[2]!.length * 0.4)
    const file = session.sessionManager.getSessionFile()!
    assert.match(await readFile(file, 'utf8'), /OUTPUT_PAYLOAD 😀 OUTPUT_PAYLOAD/)
    const reopened = SessionManager.open(file)
    assert.equal(
      JSON.stringify(reopened.buildSessionContext().messages),
      JSON.stringify(session.sessionManager.buildSessionContext().messages),
    )
    const projection = reopened.buildSessionProjection()
    assert.equal(workshopContextEdits(projection.entries).length, 0, 'Edits are idempotent')
    const messages = projection.messages
    const historicalWrite = messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall' && part.name === 'write')
        : [],
    )[0]!
    assert.ok(historicalWrite.type === 'toolCall')
    const text = String(historicalWrite.arguments.content)
    assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text)
    const callIds = messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.id)
        : [],
    )
    const resultIds = messages.flatMap((message) =>
      message.role === 'toolResult' ? [message.toolCallId] : [],
    )
    assert.deepEqual(callIds, resultIds, 'Tool call/result pairing survives context edits')
    const store = new StateStore(item.root)
    const timings = (
      await readFile(
        join(store.directory, 'timing', `${session.sessionManager.getSessionId()}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(timings.filter((row) => row.event === 'model_end').length, 8)
    assert.equal(timings.filter((row) => row.event === 'tool_end').length, 8)
    assert.ok(timings.some((row) => row.event === 'settled'))
    assert.ok(timings.filter((row) => row.event === 'model_end').every((row) => row.elapsedMs >= 0))
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('document checks preserve long URLs and reject invalid scope before edits', async () => {
  const item = await fixture()
  const path = join(item.root, 'design.md')
  const url = '[source]: https://example.com/' + 'x'.repeat(120)

  try {
    await writeFile(
      path,
      '# Design\n\n' + 'A sentence about a decision. '.repeat(15) + '\n\n' + url,
    )
    assert.equal((await checkDocuments(item.root, ['design.md'], false)).status, 'failed')
    const formatted = await checkDocuments(item.root, ['design.md'], true)
    assert.equal(formatted.status, 'passed')
    assert.deepEqual(formatted.changed, ['design.md'])
    assert.equal((await checkDocuments(item.root, ['design.md'], false)).status, 'passed')
    assert.match(await readFile(path, 'utf8'), /example.com/)
    const before = await readFile(path, 'utf8')
    await assert.rejects(checkDocuments(item.root, ['design.md', '../private.md'], true))
    assert.equal(await readFile(path, 'utf8'), before)
    await assert.rejects(checkDocuments(item.root, ['src/value.js'], true), /Markdown/)
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})
