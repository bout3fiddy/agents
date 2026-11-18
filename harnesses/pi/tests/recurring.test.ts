import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gitCommand } from '../src/git-branches.ts'
import { fixture } from './support.ts'
import { coordinatorEvidence } from './branch-support.ts'
import { captureSession } from './session-support.ts'
import { registerRecurring } from '../src/recurring-tools.ts'
import { RecurringTasks } from '../src/recurring.ts'
import { runDelegation } from '../src/delegation-runner.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { delegationDirectory, type DelegationRequest } from '../src/delegation-state.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { inventory, safePath } from '../src/paths.ts'

const owner = { session: 'original-session', model: 'openai-codex/gpt-6.1-sol' }
const interval = 60000
const documents = {
  everyMinutes: 1,
  work: {
    kind: 'documents' as const,
    task: 'Update the activity log',
    context: 'Use project evidence.',
    writePaths: ['log.md'],
  },
}
const audit = { everyMinutes: 1, work: { kind: 'audit' as const, task: 'Audit project progress' } }

async function setup(t: TestContext) {
  const { root, base } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const store = new StateStore(root)
  const started: DelegationRequest[] = []
  const open = () =>
    new RecurringTasks(store, join(base, 'private'), async (job) => {
      started.push(job)
    })
  const schedules = open()
  const tick = (now: number) => schedules.tick(owner, () => [], now)
  return { base, root, store, started, open, schedules, tick, now: Date.now() }
}

test('concurrent ticks claim once and removal cancels the active job', async (t) => {
  const { schedules, open, tick, store, started, now } = await setup(t)
  await schedules.set('log', documents, owner.session, false, now)
  await tick(now)
  await schedules.tick({ ...owner, session: 'unrelated' }, () => [], now + interval)
  assert.equal(started.length, 0)
  await Promise.all([tick(now + interval), open().tick(owner, () => [], now + interval)])
  assert.equal(started.length, 1)
  assert.deepEqual(started[0]?.writePaths, ['log.md'])
  await tick(now + 8 * interval)
  assert.equal(started.length, 1)
  await schedules.set('log', { ...documents, everyMinutes: 4 }, owner.session, false, now)
  assert.equal((await open().list())[0]?.active, started[0]?.id)
  const removed = await open().remove('log')
  const directory = delegationDirectory(store, started[0]!.id)
  assert.equal(JSON.parse(await readFile(join(directory, 'controls.json'), 'utf8')).cancelled, true)
  assert.equal(removed.removed, true)
  await tick(now + 16 * interval)
  assert.equal(started.length, 1)
  assert.deepEqual(await open().list(), [])
  assert.equal((await schedules.remove('log')).removed, false)
})

test('queue deferral, failure suspension and expiry survive retries', async (t) => {
  const { schedules, tick, now, started, store } = await setup(t)
  const research = {
    kind: 'research' as const,
    task: 'Read this project',
    context: '',
    writePaths: [],
  }
  const existing = await Promise.all(
    [1, 2].map(() => schedules.jobs.start(research, owner, async () => {})),
  )
  await schedules.set('checks', { everyMinutes: 1, work: research }, owner.session, true, now)
  await tick(now)
  assert.equal(started.length, 0)
  assert.match((await schedules.list())[0]?.error ?? '', /Two background tasks/)
  const setStatus = async (id: string, status: string) => {
    const path = join(delegationDirectory(store, id), 'status.json')
    await atomicJson(path, { id, status, updatedAt: new Date().toISOString() })
  }
  await setStatus(existing[0]!.request.id, 'complete')
  await tick(now + 9 * interval)
  assert.equal(started.length, 1)
  await setStatus(started[0]!.id, 'failed')
  await tick(now + 10 * interval)
  await tick(now + 12 * interval)
  assert.equal((await schedules.list())[0]?.status, 'paused')
  assert.equal(started.length, 1)
  const until = new Date(now + 14 * interval).toISOString()
  await schedules.set(
    'checks',
    { everyMinutes: 1, work: research, until },
    'new-owner',
    false,
    now + 12 * interval,
  )
  await tick(now + 13 * interval)
  assert.equal(started.length, 1)
  await schedules.tick({ ...owner, session: 'new-owner' }, () => [], now + 14 * interval)
  assert.equal((await schedules.list(now + 14 * interval))[0]?.status, 'expired')
  assert.equal(started.length, 1)
})

test('only host-configured schedules run and invalid scopes fail at configuration', async (t) => {
  const { root, schedules, tick, now, started } = await setup(t)
  await mkdir(join(root, '.pi/recurring'), { recursive: true })
  await writeFile(join(root, '.pi/recurring/schedules.json'), JSON.stringify([documents]))
  await tick(now)
  assert.equal(started.length, 0)
  await assert.rejects(schedules.set('../audit', audit, owner.session), /schedule name/)
  await assert.rejects(schedules.set('bad', { ...audit, everyMinutes: 0 }, owner.session))
  await assert.rejects(schedules.set('bad', { ...audit, until: 'yesterday' }, owner.session))
  await assert.rejects(
    schedules.set(
      'bad',
      { ...documents, work: { ...documents.work, writePaths: ['.pi/traces/secret'] } },
      owner.session,
    ),
  )
  assert.deepEqual(await schedules.list(), [])
})

test('audits report once per activity change and only findings wake the Pi session', async (t) => {
  const { base, root, store, schedules, started, now } = await setup(t)
  let calls = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerDelegation(pi, async () => {})
      },
    ],
    async () => {
      calls++
      return [{ type: 'text', text: 'The milestone is verified.' }]
    },
  )
  t.after(async () => {
    session.dispose()
    await runtime.settleCredentialWrites()
  })
  const origin = { ...owner, session: session.sessionManager.getSessionId() }
  const poll = (at: number) => schedules.tick(origin, () => session.sessionManager.getBranch(), at)
  await schedules.set('progress', audit, origin.session, false, now)
  await poll(now)
  assert.equal(started.length, 0)
  await session.prompt('The first milestone passed')
  await poll(now + interval)
  const first = started[0]!
  assert.ok(first)
  assert.match(first.context, /first milestone passed/)
  const signal = new AbortController().signal
  const quiet = await runDelegation(store, first.id, signal, (req) =>
    coordinatorEvidence(req, { summary: 'First milestone passed.' }, []),
  )
  assert.equal(quiet.status, 'complete', quiet.error)
  assert.equal(quiet.auditAttention, false)
  const report = JSON.parse(await readFile(join(root, quiet.auditReport!), 'utf8'))
  assert.equal(report.job, first.id)
  assert.equal(report.schedule, 'progress')
  assert.ok(!(await inventory(root)).has(quiet.auditReport!))
  await assert.rejects(safePath(root, quiet.auditReport!), /unavailable/)
  await poll(now + interval + 10)
  await poll(now + 2 * interval)
  assert.equal(started.length, 1)
  await delay(1300)
  assert.equal(calls, 1)
  await session.prompt('The second milestone is blocked')
  await poll(now + 3 * interval)
  assert.equal(started.length, 2)
  assert.doesNotMatch(started[1]!.context, /first milestone passed/)
  assert.match(started[1]!.context, /second milestone is blocked/)
  const attention = await runDelegation(store, started[1]!.id, signal, (req) =>
    coordinatorEvidence(
      req,
      {
        findings: [
          {
            severity: 'suggestion',
            location: 'second milestone',
            problem: 'Delivery blocked',
            evidence: 'Host discussion',
          },
        ],
      },
      [],
    ),
  )
  assert.equal(attention.auditAttention, true)

  for (let attempt = 0; attempt < 40; attempt++) {
    if (calls >= 3) {
      break
    }

    await delay(100)
  }

  assert.equal(calls, 3)
  await session.reload()
  await delay(1100)
  assert.equal(calls, 3)
})

test('audit report publication rejects a linked output directory', async (t) => {
  const { root, base, schedules, started, now, store } = await setup(t)
  await schedules.jobs.start(documents.work, owner, async () => {})
  await schedules.set('progress', audit, owner.session, true, now)
  await schedules.tick(owner, () => [], now)
  await mkdir(join(base, 'outside'))
  await symlink(join(base, 'outside'), join(root, '.pi/audit'))
  const job = await runDelegation(store, started[0]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, {}, []),
  )
  assert.equal(job.status, 'needs_attention')
  assert.match(job.error!, /real .pi\/audit/)
  await assert.rejects(readFile(join(base, 'outside', job.id + '.json')), { code: 'ENOENT' })
})

test('a disposed Pi session retires its scheduler after reload', async (t) => {
  const { base, root } = await setup(t)
  const { session, runtime } = await captureSession(
    root,
    base,
    [(pi) => registerRecurring(pi, 20)],
    async () => [],
  )

  try {
    await session.reload()
    session.dispose()
    await delay(150)
  } finally {
    await runtime.settleCredentialWrites()
  }
})

test('a revised audit question rechecks evidence after the active run', async (t) => {
  const { now, store, schedules, started, tick } = await setup(t)
  const source = await schedules.jobs.start(documents.work, owner, async () => {})
  await schedules.set('progress', audit, owner.session, true, now)
  await tick(now)
  await schedules.set(
    'progress',
    {
      ...audit,
      work: { ...audit.work, task: 'Check outstanding ownership conflicts' },
    },
    owner.session,
    false,
    now,
  )
  const first = started[0]!
  await runDelegation(store, first.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, {}, []),
  )
  await tick(now + 10)
  await tick(now + interval)
  assert.equal(started.length, 2)
  assert.match(started[1]!.context, new RegExp(source.request.id))
  assert.equal(started[1]!.task, 'Check outstanding ownership conflicts')
})

test('recurring document work applies scoped updates on successive ticks', async (t) => {
  const { now, store, root, schedules, started, tick } = await setup(t)
  await schedules.set('notes', documents, owner.session, true, now)

  for (let occurrence = 0; occurrence < 2; occurrence++) {
    const at = now + occurrence * interval
    await tick(at)
    assert.equal(started.length, occurrence + 1)
    const note = `# Verified cycle ${occurrence + 1}\n`
    const job = await runDelegation(
      store,
      started[occurrence]!.id,
      new AbortController().signal,
      async (req) => {
        await writeFile(join(req.workspace, 'log.md'), note)
        return coordinatorEvidence(req, {}, [])
      },
    )
    assert.equal(job.status, 'complete', job.error)
    assert.equal(await readFile(join(root, 'log.md'), 'utf8'), note)
    await tick(at + 1)
  }

  assert.notEqual(started[0]!.id, started[1]!.id)
})

test('a missing job receipt leaves the schedule removable', async (t) => {
  const { now, store, schedules, started, tick } = await setup(t)
  await schedules.set('notes', documents, owner.session, true, now)
  await tick(now)
  await rm(delegationDirectory(store, started[0]!.id), { recursive: true })
  await tick(now + interval)
  assert.equal((await schedules.list())[0]?.status, 'paused')
  const removed = await schedules.remove('notes')
  assert.equal(removed.removed, true)
  assert.match(removed.cancellationError!, /No delegated task/)
  assert.deepEqual(await schedules.list(), [])
})

test('immediate audits persist their stop reason across reopen', async (t) => {
  const { root, store, schedules, started, now, tick, open } = await setup(t)
  const work = {
    ...audit.work,
    reportDirectory: '.pi/audits/scorecards/',
    stopWhen: 'Delivery proved',
  }
  await schedules.set('progress', { ...audit, work }, owner.session, true, now)
  await tick(now)
  assert.equal(started.length, 1)
  assert.match(started[0]!.context, /Initial baseline/)
  const reason = 'The independent receipt proves completion.'
  const state = await runDelegation(store, started[0]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, { continuation: { action: 'stop', reason } }, []),
  )
  assert.equal(state.status, 'complete', state.error)
  assert.equal(state.auditAttention, true)
  assert.match(state.auditReport!, /^\.pi\/audits\/scorecards\/.*\.md$/)
  assert.ok((await readFile(join(root, state.auditReport!), 'utf8')).includes(reason))
  await tick(now + 10)
  await open().tick(owner, () => [], now + 2 * interval)
  assert.equal(started.length, 1)
  assert.equal((await open().list())[0]?.status, 'stopped')
  assert.equal((await open().list())[0]?.stoppedReason, reason)
  assert.equal((await open().list())[0]?.nextAt, undefined)
  assert.ok(!(await inventory(root)).has(state.auditReport!))
})

test('revised audits ignore stale stop decisions and report project defects', async (t) => {
  const { store, schedules, started, now, tick } = await setup(t)
  const first = { ...audit, work: { ...audit.work, stopWhen: 'All items complete' } }
  await schedules.set('progress', first, owner.session, true, now)
  await tick(now)
  const second = { ...first, work: { ...first.work, stopWhen: 'Independently verified' } }
  await schedules.set('progress', second, owner.session, true, now + 2)
  await runDelegation(store, started[0]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, { continuation: { action: 'stop', reason: 'Old condition met' } }, []),
  )
  await tick(now + 3)
  assert.equal((await schedules.list())[0]?.status, 'scheduled')
  await tick(now + 4)
  assert.equal(started.length, 2)
  const state = await runDelegation(store, started[1]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(
      req,
      {
        verdict: 'changes',
        continuation: { action: 'continue', reason: 'Awaiting evidence' },
        findings: [
          {
            severity: 'required',
            location: 'build',
            problem: 'Missing receipt',
            evidence: 'status.md',
          },
        ],
      },
      [],
    ),
  )
  assert.equal(state.status, 'complete', state.error)
  await tick(now + 5)
  assert.equal((await schedules.list())[0]?.status, 'scheduled')
})

test('audit destinations reject traversal and linked parents', async (t) => {
  const { base, root, schedules, store, tick, now, started } = await setup(t)

  for (const path of ['../outside', '.pi/audits/../traces', '.pi/traces', '.pi/audits//bad']) {
    await assert.rejects(
      schedules.set(
        'progress',
        { ...audit, work: { ...audit.work, reportDirectory: path } },
        owner.session,
      ),
    )
  }

  await assert.rejects(
    schedules.set(
      'progress',
      { ...audit, work: { ...audit.work, model: 'fable', thinking: 'low' } },
      owner.session,
    ),
    /medium or high/,
  )
  const work = { ...audit.work, reportDirectory: '.pi/audits/reports' }
  await schedules.set('progress', { ...audit, work }, owner.session, true, now)
  await mkdir(join(base, 'outside'))
  await symlink(join(base, 'outside'), join(root, '.pi/audits'))
  await tick(now)
  const job = await runDelegation(store, started[0]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, {}, []),
  )
  assert.equal(job.status, 'needs_attention')
  assert.match(job.error!, /real .pi\/audits/)
  await assert.rejects(readFile(join(base, 'outside/reports')), { code: 'ENOENT' })
})

test('a new Git commit wakes an idle audit once', async (t) => {
  const { root, store, schedules, started, now, tick } = await setup(t)
  await gitCommand(root, ['init', '-q'])
  const commit = () =>
    gitCommand(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ])
  await commit()
  await schedules.set('progress', audit, owner.session, false, now)
  await tick(now + interval)
  assert.equal(started.length, 1)
  assert.ok(started[0]!.context.includes(await gitCommand(root, ['rev-parse', 'HEAD'])))
  await runDelegation(store, started[0]!.id, new AbortController().signal, (req) =>
    coordinatorEvidence(req, {}, []),
  )
  await tick(now + interval + 1)
  await tick(now + interval * 2)
  assert.equal(started.length, 1)
  await commit()
  await tick(now + interval * 3)
  assert.equal(started.length, 2)
  assert.ok(started[1]!.context.includes(await gitCommand(root, ['rev-parse', 'HEAD'])))
})

test('late audit guidance prevents publication of an obsolete stop decision', async (t) => {
  const { root, schedules, store, tick, now, started } = await setup(t)
  await schedules.set(
    'progress',
    {
      ...audit,
      work: { ...audit.work, stopWhen: 'Complete', reportDirectory: '.pi/audits/progress' },
    },
    owner.session,
    true,
    now,
  )
  await tick(now)
  const job = await runDelegation(
    store,
    started[0]!.id,
    new AbortController().signal,
    async (req) => {
      await schedules.jobs.control(started[0]!.id, 'message', 'A second milestone is outstanding')
      return coordinatorEvidence(
        req,
        { continuation: { action: 'stop', reason: 'Initial gate met' } },
        [],
      )
    },
  )
  assert.equal(job.status, 'needs_attention')
  assert.match(job.error!, /late task update/)
  assert.equal(job.auditReport, undefined)
  await assert.rejects(readFile(join(root, '.pi/audits/progress')), { code: 'ENOENT' })
})
