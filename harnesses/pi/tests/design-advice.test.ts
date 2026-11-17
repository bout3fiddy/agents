import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { consultationInput, DesignConsultations, type Advice } from '../src/design-advice.ts'
import { fixture } from './support.ts'
import { loadRole } from '../src/roles.ts'

test('parallel advice persists results and respects session ownership', async () => {
  const item = await fixture()
  let release!: (advice: Advice) => void
  const advice = new Promise<Advice>((resolve) => {
    release = resolve
  })
  const delivered: string[] = []
  let observed!: () => void
  const automaticResult = new Promise<void>((resolve) => {
    observed = resolve
  })
  const consultations = new DesignConsultations(async (_input, signal) => {
    const abort = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    })
    return Promise.race([advice, abort])
  })

  try {
    const first = await consultations.start(item.store, 'session-a', '{}', 'Q1', (job) => {
      delivered.push(job.id)
      observed()
    })
    assert.equal(first.status, 'running')

    // Starting another task must remain possible before the first model call finishes.
    const second = await consultations.start(item.store, 'session-a', '{}', 'Q2', (job) =>
      delivered.push(job.id),
    )
    await assert.rejects(
      consultations.start(item.store, 'session-a', '{}', 'Q3', () => {}),
      /already running/,
    )
    await assert.rejects(
      consultations.get(item.store, 'other-session', first.id),
      /current session/,
    )
    await assert.rejects(consultations.get(item.store, 'session-a', '../private'), /Invalid/)
    await consultations.settle(second.id, true)
    assert.equal((await consultations.get(item.store, 'session-a', second.id)).status, 'cancelled')
    release({ text: 'Independent recommendation', model: 'claude-cli/test' })
    await automaticResult
    assert.equal((await consultations.get(item.store, 'session-a', first.id)).status, 'complete')
    assert.deepEqual(delivered, [first.id])
    const restarted = new DesignConsultations()
    assert.equal(
      (await restarted.get(item.store, 'session-a', first.id)).advice?.text,
      'Independent recommendation',
    )
  } finally {
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('failed, aborted and abandoned consultations never claim a successful response', async () => {
  const item = await fixture()
  const consultations = new DesignConsultations(async () => {
    throw new Error('Provider offline')
  })

  try {
    const job = await consultations.start(item.store, 'session', '{}', 'Question', () => {})
    await consultations.settle(job.id, false)
    const failed = await consultations.get(item.store, 'session', job.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'Provider offline')
    await writeFile(
      join(item.store.directory, 'consultations', `${job.id}.json`),
      JSON.stringify({ ...job, status: 'running' }),
    )
    assert.equal((await consultations.get(item.store, 'session', job.id)).status, 'cancelled')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      consultations.start(item.store, 'session', '{}', 'Question', () => {}, controller.signal),
      { name: 'AbortError' },
    )
  } finally {
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('Fable receives bounded user context and permitted documents', async () => {
  const item = await fixture()
  await mkdir(join(item.root, 'design'))
  await writeFile(join(item.root, 'design/design.md'), 'A decision is still open.')
  await writeFile(join(item.root, '.env'), 'PRIVATE_SENTINEL')

  try {
    const input = JSON.parse(
      await consultationInput(
        item.store,
        { question: 'Which failure mode matters?', paths: ['design/design.md'] },
        ['EXACT_USER_PROMPT'],
      ),
    )
    assert.deepEqual(input.userMessages, ['EXACT_USER_PROMPT'])
    assert.equal(input.documents[0].content, 'A decision is still open.')
    await assert.rejects(consultationInput(item.store, { question: 'Q', paths: ['.env'] }, []))
    await assert.rejects(
      consultationInput(item.store, { question: 'Q', paths: ['../outside'] }, []),
    )
    await assert.rejects(
      consultationInput(item.store, { question: 'Q' }, ['x'.repeat(160001)]),
      /160 KB/,
    )
    const withoutHistory = JSON.parse(
      await consultationInput(
        item.store,
        { question: 'Q', historyMessages: 0, context: 'Necessary constraint' },
        ['x'.repeat(160001)],
      ),
    )
    assert.deepEqual(withoutHistory.userMessages, [])
    assert.equal(withoutHistory.olderUserMessagesOmitted, 1)
    const implementer = await loadRole('implementer')
    assert.equal(implementer.model, 'openai-codex/gpt-6-astra')
    assert.equal(implementer.thinking, 'high')
    const advisor = await loadRole('design-advisor')
    assert.equal(advisor.model, 'claude-fable-5-2')
    assert.ok(['medium', 'high'].includes(advisor.thinking))
    assert.deepEqual(advisor.tools, [])
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('waiting consumes advice once and interrupted waits preserve background work', async () => {
  const item = await fixture()
  let release!: (advice: Advice) => void
  let deliveries = 0
  let entered!: () => void
  let modelEntry = new Promise<void>((resolve) => {
    entered = resolve
  })
  const runner = (_input: string, signal: AbortSignal) =>
    new Promise<Advice>((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
      entered()
    })
  const consultations = new DesignConsultations(runner)

  try {
    const first = await consultations.start(item.store, 'session', '{}', 'Q1', () => {
      deliveries++
    })
    await modelEntry
    const waiting = consultations.settle(first.id, false)
    release({ text: 'First advice', model: 'test' })
    await waiting
    assert.equal(deliveries, 0)
    assert.equal(
      (await consultations.get(item.store, 'session', first.id)).advice?.text,
      'First advice',
    )
    let delivered!: () => void
    const automatic = new Promise<void>((resolve) => {
      delivered = resolve
    })
    modelEntry = new Promise<void>((resolve) => {
      entered = resolve
    })
    const toolSignal = new AbortController()
    const second = await consultations.start(
      item.store,
      'session',
      '{}',
      'Q2',
      () => {
        deliveries++
        delivered()
      },
      toolSignal.signal,
    )
    const abortWait = new AbortController()
    const interrupted = consultations.settle(second.id, false, abortWait.signal)
    abortWait.abort()
    toolSignal.abort()
    await assert.rejects(interrupted, /wait interrupted/)
    assert.equal((await consultations.get(item.store, 'session', second.id)).status, 'running')
    await modelEntry
    release({ text: 'Second advice', model: 'test' })
    await automatic
    assert.equal(deliveries, 1)
  } finally {
    release?.({ text: 'Cleanup', model: 'test' })
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('teardown rejects prepared calls and navigation invalidates their epoch', async () => {
  const item = await fixture()
  const consultations = new DesignConsultations(async () => ({ text: 'Advice', model: 'test' }))

  try {
    const epoch = consultations.epoch
    await consultations.cancelAll()
    await assert.rejects(
      consultations.start(item.store, 'session', '{}', 'Q', () => {}, undefined, epoch),
      /context changed/,
    )
    const current = await consultations.start(item.store, 'session', '{}', 'Q', () => {})
    await consultations.settle(current.id, false)
    assert.equal((await consultations.get(item.store, 'session', current.id)).status, 'complete')
    await consultations.close()
    await assert.rejects(
      consultations.start(item.store, 'session', '{}', 'Q', () => {}),
      /context changed/,
    )
  } finally {
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('shutdown aborts active advice and suppresses late follow-up delivery', async () => {
  const item = await fixture()
  let delivered = false
  const consultations = new DesignConsultations(async (_input, signal) => {
    await delay(60000, undefined, { signal })
    return { text: 'Late result', model: 'test' }
  })

  try {
    const job = await consultations.start(item.store, 'session', '{}', 'Question', () => {
      delivered = true
    })
    await consultations.close()
    assert.equal(delivered, false)
    const saved = JSON.parse(
      await readFile(join(item.store.directory, 'consultations', `${job.id}.json`), 'utf8'),
    )
    assert.equal(saved.status, 'cancelled')
  } finally {
    await consultations.close()
    await rm(item.base, { recursive: true, force: true })
  }
})
