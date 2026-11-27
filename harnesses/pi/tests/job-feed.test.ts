import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { createHarness } from '../src/extension.ts'
import { runJob } from '../src/job-runner.ts'
import { jobStore, outcomeType } from '../src/job-tools.ts'
import { WorkersCatalog } from '../src/workers-data.ts'
import { captureSession } from './session-support.ts'
import { evidence, fixture } from './support.ts'

const start = {
  title: 'Set the value',
  task: 'Make value 1.',
  mode: 'implement',
  writePaths: ['src/**'],
}
const startCall = [{ type: 'toolCall' as const, id: 'start', name: 'job_start', arguments: start }]
const said = (context: Context) => JSON.stringify(context.messages)
const outcomes = (context: Context) => said(context).split('Background job outcome').length - 1

/** A host session whose jobs are launched by the test instead of a detached runner. */
async function host(
  t: TestContext,
  respond: (context: Context, turn: number) => Promise<string | AssistantMessage['content']>,
  wrap: (pi: ExtensionAPI) => ExtensionAPI = (pi) => pi,
) {
  const item = await fixture()
  const launches: string[] = []
  const launch = async (_store: unknown, id: string) => void launches.push(id)
  const harness = createHarness({ jobs: { launch, tickMs: 15, retryMs: 60 } })
  const contexts: Context[] = []
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [(pi) => harness(wrap(pi))],
    async (context) => {
      contexts.push(context)
      const reply = await respond(context, contexts.length)
      return typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply
    },
  )
  t.after(async () => {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  })
  const store = jobStore(item.root)

  /** Run the queued job in this process, with a worker that sets the value. */
  const work = (value = 'export const value = 1\n') =>
    runJob(store, store.list()[0]!.id, async (request) => {
      await writeFile(join(request.workspace, 'src/value.js'), value)
      return evidence(request)
    })
  const until = async (condition: () => boolean) => {
    for (let waited = 0; !condition() && waited < 4000; waited += 10) {
      await delay(10)
    }

    assert.ok(condition(), 'condition was not reached')
  }
  const waitForOutcome = async () => {
    await until(() => contexts.some((context) => outcomes(context) > 0))
    await session.waitForIdle()
    const latest = contexts.at(-1)!
    assert.equal(outcomes(latest), 1, 'the model saw exactly one outcome')
    return said(latest)
  }
  return { ...item, session, store, contexts, launches, work, until, waitForOutcome }
}

test('an outcome wakes an idle host once and is acknowledged from the transcript', async (t) => {
  const h = await host(t, async (_context, turn) => (turn === 1 ? startCall : 'Noted.'))
  await h.session.prompt('Set the value to 1.')
  const [job] = h.store.list()
  assert.equal(job?.status, 'queued')
  assert.match(said(h.contexts[1]!), /The outcome arrives automatically/)
  const done = await h.work()
  assert.equal(done?.status, 'done', done?.error)
  await h.waitForOutcome()
  assert.match(said(h.contexts[2]!), /"status\\":\\"done\\"/)
  assert.match(said(h.contexts[3]!), /Before you stop: nothing is running/)
  assert.match(said(h.contexts[2]!), /already in the checkout/)
  assert.equal(await readFile(join(h.root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
  await h.until(() => h.store.pendingEvents(job!.session).length === 0)
  await delay(150)
  assert.equal(h.contexts.length, 4, 'an acknowledged outcome is not offered again')
  assert.equal(outcomes(h.contexts[2]!), 1)
})

test('an outcome that finishes during a turn joins it at the next boundary', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await host(t, async (_context, turn) => {
    if (turn === 1) {
      return startCall
    }

    if (turn === 2) {
      await gate
      return 'Still talking.'
    }

    return 'Result seen.'
  })
  const turn = h.session.prompt('Set the value to 1.')
  await h.until(() => h.contexts.length === 2)
  await h.work()
  release()
  await turn
  await h.session.waitForIdle()
  assert.equal(h.contexts.length, 4, 'the same run continues; no second wake is needed')
  assert.equal(outcomes(h.contexts[2]!), 1)
  await delay(150)
  assert.equal(h.contexts.length, 4)
})

test('a wake that is lost is offered again until its message is persisted', async (t) => {
  let dropped = 0
  const h = await host(
    t,
    async (_context, turn) => (turn === 1 ? startCall : 'Noted.'),
    (pi) => ({
      ...pi,
      sendMessage(message, options) {
        const outcome = (message as { customType?: string }).customType === outcomeType

        if (outcome && dropped < 2) {
          dropped++
          return
        }

        pi.sendMessage(message, options)
      },
    }),
  )
  await h.session.prompt('Set the value to 1.')
  await h.work()
  const delivered = await h.waitForOutcome()
  assert.equal(dropped, 2)
  assert.match(delivered, /"status\\":\\"done\\"/)
  await h.until(() => h.store.pendingEvents(h.store.get('j1').session).length === 0)
})

test('a host that worked is asked once before stopping, and not while a job runs', async (t) => {
  const list = [{ type: 'toolCall' as const, id: 'ls', name: 'ls', arguments: { path: '.' } }]
  const h = await host(t, async (_context, turn) =>
    turn === 1 || turn === 3 ? list : turn === 6 ? startCall : 'Noted.',
  )
  await h.session.prompt('Look around and ship it.')
  assert.equal(h.contexts.length, 5, 'asked after each stretch of work, then left alone')
  assert.match(said(h.contexts[2]!), /Before you stop: nothing is running/)
  assert.equal(said(h.contexts[4]!).split('Before you stop').length - 1, 2)
  await h.session.prompt('Set the value to 1.')
  assert.equal(h.contexts.length, 7, 'a running job is the reason to stop')
  await h.session.prompt('Thanks.')
  assert.equal(h.contexts.length, 8, 'a reply without work is not questioned')
})

test('a stopped job is restated every turn until the host resolves it', async (t) => {
  const retry = [
    {
      type: 'toolCall' as const,
      id: 'retry',
      name: 'job_retry',
      arguments: { id: 'j1', guidance: 'Do not write the word broken.' },
    },
  ]
  let retryTurn: number | undefined
  const h = await host(t, async (_context, turn) =>
    turn === 1 ? startCall : turn === retryTurn ? retry : 'Noted.',
  )
  await h.session.prompt('Set the value to 1.')
  const stopped = await runJob(h.store, h.store.list()[0]!.id, async (request) =>
    evidence(request, { verdict: 'blocked', summary: 'Needs the registry.' }),
  )
  assert.equal(stopped?.status, 'needs_attention')
  await h.waitForOutcome()
  await h.session.prompt('What about the weather?')
  const later = said(h.contexts.at(-1)!)
  assert.match(later, /Open jobs of this session, as recorded/)
  assert.match(later, /needs_attention/)
  assert.equal(later.split('Open jobs of this session').length - 1, 1, 'only the latest statement')
  retryTurn = h.contexts.length + 1
  await h.session.prompt('Retry it.')
  assert.equal(h.store.get('j1').status, 'queued')
  assert.deepEqual(h.store.takeMessages(h.store.get('j1').id), ['Do not write the word broken.'])
})

function control(name: string, args: Record<string, string>) {
  return [{ type: 'toolCall' as const, id: name, name, arguments: args }]
}

test('one host turn cancels and restarts its queued job without a manual command', async (t) => {
  const cancel = control('codemode', {
    code: 'text(await tools.job_cancel({ id: "j1", reason: "Restart with corrected guidance." }))',
  })
  const retry = control('job_retry', { id: 'j1', guidance: 'Use the corrected input.' })
  const h = await host(t, async (_context, turn) =>
    turn === 1 ? startCall : turn === 2 ? cancel : turn === 3 || turn === 4 ? retry : 'Noted.',
  )
  await h.session.prompt('Start the job, then restart it with corrected guidance.')
  const [job] = h.store.list()
  assert.match(said(h.contexts[2]!), /"status\\":\\"cancelled\\"/)
  assert.match(said(h.contexts[2]!), /Restart with corrected guidance/)
  assert.equal(job?.status, 'queued')
  assert.deepEqual(h.launches, [job.id, job.id])
  assert.deepEqual(h.store.takeMessages(job.id), ['Use the corrected input.'])
  assert.deepEqual(h.store.pendingEvents(job.session), [])
  assert.match(said(h.contexts[4]!), /only a stopped job can be retried/)
})

test('a running stop waits for its outcome and never retries a sibling', async (t) => {
  const cancel = control('job_cancel', { id: 'j1', reason: 'Correct the input.' })
  const retry = control('job_retry', { id: 'j1', guidance: 'Use the correction.' })
  const h = await host(t, async (context, turn) => {
    if (turn === 1) {
      return startCall
    }

    if (turn === 2) {
      const job = h.store.get('j1')
      h.store.claim(job.id, process.pid)
      h.store.create({ root: h.root, session: job.session, spec: job.spec })
      return cancel
    }

    if (turn === 3) {
      return retry
    }

    if (turn === 4) {
      h.store.finish(h.store.get('j1').id, 'needs_attention')
      return 'Awaiting the outcome.'
    }

    return turn === 5 && outcomes(context) === 1 ? retry : 'Noted.'
  })

  // The transcript survives a store version change; old numeric receipts must not swallow
  // a new job's first outcome, even though the fresh store numbers events from one again.
  h.session.sessionManager.appendCustomMessageEntry(outcomeType, 'Earlier job.', false, {
    events: [1],
  })
  await h.session.prompt('Restart the first job with corrected input.')
  const job = h.store.get('j1')
  assert.match(said(h.contexts[2]!), /Stop requested/)
  assert.match(said(h.contexts[3]!), /only a stopped job can be retried/)
  assert.deepEqual(h.launches, [job.id, job.id])
  assert.equal(job.status, 'queued')
  assert.deepEqual(h.store.takeMessages(job.id), ['Use the correction.'])
  assert.equal(h.store.get('j2').cancellation, undefined)
  assert.equal(h.store.get('j2').status, 'queued')
})

test('another session cannot control jobs even from code mode', async (t) => {
  const code = [
    'await Promise.allSettled([tools.job_cancel({id:"j1",reason:"stop"}),',
    'tools.job_retry({id:"j2",guidance:"retry"}),tools.job_message({id:"j1",text:"edit"}),',
    'tools.job_close({id:"j2",reason:"close"})]).then(text)',
  ].join('')
  const h = await host(t, async (_context, turn) =>
    turn === 1 ? control('codemode', { code }) : 'Noted.',
  )
  const input = {
    root: h.root,
    session: 'other',
    spec: {
      title: 'Count',
      task: 'Count files.',
      mode: 'research' as const,
      deliver: 'none' as const,
      writePaths: [],
      model: 'capture/capture',
    },
  }
  const active = h.store.create(input)
  const stopped = h.store.finish(h.store.create(input).id, 'needs_attention')
  await h.session.prompt('Try to control the other session’s jobs.')
  assert.match(said(h.contexts[1]!), /belongs to another session/)
  assert.deepEqual(h.store.get(active.id), active)
  assert.deepEqual(h.store.get(stopped.id), stopped)
  assert.deepEqual(h.store.takeMessages(active.id), [])
  assert.deepEqual(h.launches, [])
})

test('/jobs cancel stops the job and blocks an unsolicited retry', async (t) => {
  const close = [
    {
      type: 'toolCall' as const,
      id: 'close',
      name: 'job_close',
      arguments: { id: 'j1', reason: 'Superseded.' },
    },
  ]
  const retry = control('job_retry', { id: 'j1', guidance: 'Resume the original job.' })
  let resume = false
  let attempted = false
  const h = await host(t, async (context, turn) => {
    if (outcomes(context) && (!attempted || resume)) {
      attempted = true
      resume = false
      return retry
    }

    return turn === 1 ? startCall : turn === 2 ? close : 'Noted.'
  })
  await h.session.prompt('Set the value to 1, then change your mind.')
  assert.match(said(h.contexts[2]!), /Only a needs_attention job can be closed/)
  assert.equal(h.store.get('j1').status, 'queued', 'close is not a stop request')
  const rows = await new WorkersCatalog(h.root).list()
  assert.deepEqual(
    rows.map((row) => [row.info.role, row.taskStatus, row.active]),
    [['job', 'queued', true]],
    'a queued job is visible before any worker exists',
  )
  await h.session.prompt('/jobs cancel j1')
  assert.equal(h.store.get('j1').status, 'cancelled')
  const delivered = await h.waitForOutcome()
  assert.match(delivered, /"status\\":\\"cancelled\\"/)
  assert.match(delivered, /retry only on a new request from the user/)
  assert.equal(h.store.get('j1').status, 'cancelled')
  assert.equal(h.launches.length, 1)
  resume = true
  await h.session.prompt('Please resume j1 now.')
  assert.equal(h.store.get('j1').status, 'queued')
  assert.equal(h.launches.length, 2)
})

test('job_start validates scope, refs and delivery before anything is recorded', async (t) => {
  const bad = [
    { ...start, writePaths: [] },
    { ...start, writePaths: ['src/*.js'] },
    { ...start, deliver: 'branch' },
    { ...start, deliver: 'branch', branch: '--force' },
    { ...start, base: '--upload-pack=x' },
    { ...start, mode: 'documents', design: {} },
  ]
  const h = await host(t, async (_context, turn) =>
    turn <= bad.length
      ? [{ type: 'toolCall', id: `bad-${turn}`, name: 'job_start', arguments: bad[turn - 1]! }]
      : 'Done.',
  )
  await h.session.prompt('Try invalid jobs.')
  const results = h.session.state.messages.filter((message) => message.role === 'toolResult')
  assert.equal(results.length, bad.length)
  assert.ok(results.every((result) => result.isError))
  assert.deepEqual(h.store.list(), [])
})
