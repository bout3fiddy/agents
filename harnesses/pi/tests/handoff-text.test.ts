import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'
import { ToolCallArgumentsStream } from '@earendil-works/pi-ai/utils/streaming-json'
import { consultationInput, DesignConsultations } from '../src/design-advice.ts'
import { fixture } from './support.ts'

const prose = '  Keep ordinary word spacing.\nQuoted: "two  spaces"; café 🧪.\t'
const context = 'Keep feeTokens, snake_case, docs/a-b.md and https://example.test/a?q=b exact.'

test('SDK streamed tool arguments preserve prose across every two-chunk boundary', () => {
  const expected = { question: prose, context }
  const encoded = JSON.stringify(expected)

  for (let split = 0; split <= encoded.length; split++) {
    const stream = new ToolCallArgumentsStream()
    stream.append(encoded.slice(0, split))
    stream.append(encoded.slice(split))
    assert.equal(stream.text, encoded)
    assert.deepEqual(stream.finish(), { arguments: expected })
  }

  const stream = new ToolCallArgumentsStream()

  for (const character of encoded) {
    stream.append(character)
  }

  assert.deepEqual(stream.finish(), { arguments: expected })
  stream.replace(JSON.stringify({ question: prose + 'Final text.', context }))
  assert.equal(stream.finish().arguments.question, prose + 'Final text.')
})

test('a consultation retains exact prose through its persisted handoff', async () => {
  const item = await fixture()
  let received = ''
  const consultations = new DesignConsultations(async (input) => {
    received = input
    return { text: 'Advice received.', model: 'test' }
  })

  try {
    const input = await consultationInput(item.store, { question: prose, context }, [prose])
    const job = await consultations.start(item.store, 'session', input, prose, () => {})
    await consultations.settle(job.id, false)
    assert.equal(JSON.parse(received).question, prose)
    assert.equal(JSON.parse(received).confirmedContext, context)
    assert.deepEqual(JSON.parse(received).userMessages, [prose])
    const restarted = new DesignConsultations()
    assert.equal((await restarted.get(item.store, 'session', job.id)).question, prose)
  } finally {
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})
