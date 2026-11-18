import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { consultationInput, DesignConsultations, type Advice } from '../src/design-advice.ts'
import { fixture } from './support.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'

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
  const firstInput = JSON.stringify({ question: 'Q1' })
  const consultations = new DesignConsultations(async (input, signal, _tracePath, thinking) => {
    assert.equal(thinking, input === firstInput ? 'high' : undefined)
    const abort = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    })
    return Promise.race([advice, abort])
  })

  try {
    const first = await consultations.start(
      item.store,
      'session-a',
      firstInput,
      'Q1',
      (job) => {
        delivered.push(job.id)
        observed()
      },
      undefined,
      undefined,
      'high',
    )
    assert.equal(first.status, 'running')

    // Starting another task must remain possible before the first model call finishes.
    const second = await consultations.start(item.store, 'session-a', '{}', 'Q2', (job) => {
      delivered.push(job.id)
    })
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
      /48 KB/,
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
    assert.equal(implementer.model, 'openai-codex/gpt-6.2-astra')
    assert.equal(implementer.thinking, 'medium')
    const advisor = await loadRole('design-advisor')
    assert.equal(advisor.model, 'claude-fable-5-2')
    assert.ok(['medium', 'high'].includes(advisor.thinking))
    assert.deepEqual(advisor.tools, ['WebSearch', 'WebFetch'])
  } finally {
    await rm(item.base, { recursive: true, force: true })
  }
})

test('completed advice has one consumer across late waits and racing readers', async () => {
  const item = await fixture()
  const jobs = new DesignConsultations(async () => ({ text: 'one result', model: 'test' }))

  try {
    const job = await jobs.start(item.store, 'session', '{}', 'Question', () => {})
    await jobs.settle(job.id, false)
    assert.equal(jobs.available('session').length, 1)
    const claimed = await Promise.all([
      jobs.claim(item.store, 'session', job.id, 'tool'),
      jobs.claim(item.store, 'session', job.id, 'automatic'),
    ])
    assert.equal(claimed.filter(Boolean).length, 1)
    assert.equal(jobs.available('session').length, 0)
    assert.equal(await jobs.claim(item.store, 'session', job.id, 'automatic'), undefined)
    const restarted = new DesignConsultations()
    assert.equal(await restarted.claim(item.store, 'session', job.id, 'tool'), undefined)
    assert.equal((await restarted.get(item.store, 'session', job.id)).advice?.text, 'one result')
  } finally {
    await jobs.close()
    await rm(item.base, { recursive: true, force: true })
  }
})

test('excerpts bound documents and disclose omitted user history', async () => {
  const item = await fixture()

  try {
    await writeFile(
      join(item.root, 'architecture.md'),
      Array.from({ length: 2000 }, (_, n) => `Line ${n + 1}: design detail`).join('\n'),
    )
    await assert.rejects(
      consultationInput(
        item.store,
        {
          question: 'Q',
          paths: ['architecture.md'],
        },
        [],
      ),
      /select relevant line ranges/,
    )
    const input = JSON.parse(
      await consultationInput(
        item.store,
        {
          question: 'Q',
          context: 'Keep the original durability constraint',
          historyMessages: 3,
          excerpts: [{ path: 'architecture.md', startLine: 50, lines: 3 }],
        },
        ['first', 'second', 'third', 'fourth'],
      ),
    )
    assert.match(input.documents[0].content, /^Line 50:/)
    assert.doesNotMatch(input.documents[0].content, /Line 53:/)
    assert.deepEqual(input.userMessages, ['second', 'third', 'fourth'])
    assert.equal(input.olderUserMessagesOmitted, 1)
    assert.equal(input.confirmedContext, 'Keep the original durability constraint')
    assert.equal(input.responseBudgetWords, 350)
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

for (const interruption of ['new-input', 'abort', 'navigation'] as const) {
  test(`claim interrupted by ${interruption} cannot mark unseen advice delivered`, async () => {
    const item = await fixture()
    let valid = true
    let interrupted = false
    const controller = new AbortController()
    const jobs = new DesignConsultations(
      async () => ({ text: 'Advice', model: 'test' }),
      () => {},
      async (path, value) => {
        await atomicJson(path, value)

        if (!interrupted && (value as { delivery?: { via: string } }).delivery?.via === 'tool') {
          interrupted = true

          if (interruption === 'new-input') {
            valid = false
          } else if (interruption === 'abort') {
            controller.abort()
          } else {
            await jobs.cancelAll()
          }
        }
      },
    )

    try {
      const job = await jobs.start(item.store, 'session', '{}', 'Q', () => {})
      await jobs.settle(job.id, false)
      assert.equal(
        await jobs.claim(item.store, 'session', job.id, 'tool', {
          valid: () => valid,
          signal: controller.signal,
        }),
        undefined,
      )
      const saved = await jobs.get(item.store, 'session', job.id)
      assert.equal(saved.delivery?.via, interruption === 'navigation' ? 'superseded' : undefined)

      if (interruption !== 'navigation') {
        assert.equal(jobs.available('session').length, 1)
        assert.equal(
          (await jobs.claim(item.store, 'session', job.id, 'automatic'))?.advice?.text,
          'Advice',
        )
      }
    } finally {
      await jobs.close()
      await rm(item.base, { recursive: true, force: true })
    }
  })
}

test('failed result persistence cannot poison the ready queue', async () => {
  const item = await fixture()
  let notify!: () => void
  const notified = new Promise<void>((resolve) => {
    notify = resolve
  })
  const jobs = new DesignConsultations(
    async () => ({ text: 'Advice', model: 'test' }),
    () => {},
    async () => {
      throw new Error('Injected storage failure')
    },
  )

  try {
    await jobs.start(item.store, 'session', '{}', 'Q', (job) => {
      assert.equal(job.status, 'failed')
      assert.equal(job.error, 'Could not persist the consultation result')
      notify()
    })
    await notified
    assert.deepEqual(jobs.available('session'), [])
  } finally {
    await jobs.close()
    await rm(item.base, { recursive: true, force: true })
  }
})
