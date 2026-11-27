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
  const harness = createHarness({ jobs: { launch: async () => {}, tickMs: 15, retryMs: 60 } })
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
  return { ...item, session, store, contexts, work, until }
}

test('an outcome wakes an idle host once and is acknowledged from the transcript', async (t) => {
  const h = await host(t, async (_context, turn) => (turn === 1 ? startCall : 'Noted.'))
  await h.session.prompt('Set the value to 1.')
  const [job] = h.store.list()
  assert.equal(job?.status, 'queued')
  assert.match(said(h.contexts[1]!), /The outcome arrives automatically/)
  const done = await h.work()
  assert.equal(done?.status, 'done', done?.error)
  await h.until(() => h.contexts.length === 3)
  await h.session.waitForIdle()
  assert.match(said(h.contexts[2]!), /"status\\":\\"done\\"/)
  assert.match(said(h.contexts[2]!), /already in the checkout/)
  assert.equal(await readFile(join(h.root, 'src/value.js'), 'utf8'), 'export const value = 1\n')
  await h.until(() => h.store.pendingEvents(job!.session).length === 0)
  await delay(150)
  assert.equal(h.contexts.length, 3, 'an acknowledged outcome is not offered again')
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
  assert.equal(h.contexts.length, 3, 'the same run continues; no second wake is needed')
  assert.equal(outcomes(h.contexts[2]!), 1)
  await delay(150)
  assert.equal(h.contexts.length, 3)
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
  await h.until(() => h.contexts.length === 3)
  await h.session.waitForIdle()
  assert.equal(dropped, 2)
  assert.equal(outcomes(h.contexts[2]!), 1)
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
  const h = await host(t, async (_context, turn) =>
    turn === 1 ? startCall : turn === 5 ? retry : 'Noted.',
  )
  await h.session.prompt('Set the value to 1.')
  const stopped = await runJob(h.store, h.store.list()[0]!.id, async (request) =>
    evidence(request, { verdict: 'blocked', summary: 'Needs the registry.' }),
  )
  assert.equal(stopped?.status, 'needs_attention')
  await h.until(() => h.contexts.length === 3)
  await h.session.waitForIdle()
  await h.session.prompt('What about the weather?')
  const later = said(h.contexts[3]!)
  assert.match(later, /Open jobs of this session, as recorded/)
  assert.match(later, /needs_attention/)
  assert.equal(later.split('Open jobs of this session').length - 1, 1, 'only the latest statement')
  await h.session.prompt('Retry it.')
  assert.equal(h.store.get('j1').status, 'queued')
  assert.deepEqual(h.store.takeMessages(h.store.get('j1').id), ['Do not write the word broken.'])
})

test('only the user cancels: /jobs cancel stops the job and the model is told', async (t) => {
  const close = [
    {
      type: 'toolCall' as const,
      id: 'close',
      name: 'job_close',
      arguments: { id: 'j1', reason: 'Superseded.' },
    },
  ]
  const h = await host(t, async (_context, turn) =>
    turn === 1 ? startCall : turn === 2 ? close : 'Noted.',
  )
  await h.session.prompt('Set the value to 1, then change your mind.')
  assert.match(said(h.contexts[2]!), /Only a needs_attention job can be closed/)
  assert.equal(h.store.get('j1').status, 'queued', 'the model could not stop it')
  const rows = await new WorkersCatalog(h.root).list()
  assert.deepEqual(
    rows.map((row) => [row.info.role, row.taskStatus, row.active]),
    [['job', 'queued', true]],
    'a queued job is visible before any worker exists',
  )
  await h.session.prompt('/jobs cancel j1')
  assert.equal(h.store.get('j1').status, 'cancelled')
  await h.until(() => h.contexts.length === 4)
  await h.session.waitForIdle()
  assert.match(said(h.contexts[3]!), /"status\\":\\"cancelled\\"/)
  assert.match(said(h.contexts[3]!), /never restart it without a new request/)
})
