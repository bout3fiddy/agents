import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jobLimits, JobStore, jobView, schemaVersion, type JobSpec } from '../src/job-store.ts'

async function store(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'pi-job-store-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const jobs = new JobStore(base, join(base, 'state'))
  t.after(() => jobs.close())
  return { base, jobs }
}

const spec: JobSpec = {
  title: 'Count',
  task: 'Count the files.',
  mode: 'research',
  deliver: 'none',
  writePaths: [],
  model: 'fixture/model',
}

test('a keyed job is created once per session however often the script runs', async (t) => {
  const { base, jobs } = await store(t)
  const first = jobs.create({ root: base, session: 's1', spec, key: 'count' })
  const again = jobs.create({ root: base, session: 's1', spec, key: 'count' })
  const other = jobs.create({ root: base, session: 's2', spec, key: 'count' })
  assert.equal(again.id, first.id)
  assert.notEqual(other.id, first.id)
  assert.deepEqual(
    jobs.list().map((job) => job.number),
    [2, 1],
  )
})

test('jobs resolve by short label, number or UUID prefix', async (t) => {
  const { base, jobs } = await store(t)
  const job = jobs.create({ root: base, session: 's1', spec })
  assert.equal(jobs.get('j1').id, job.id)
  assert.equal(jobs.get('1').id, job.id)
  assert.equal(jobs.get(job.id.slice(0, 8)).id, job.id)
  assert.throws(() => jobs.get('j9'), /No job j9/)
  assert.equal(jobs.find('../etc'), undefined)
  assert.equal(jobView(job).id, 'j1')
})

test('only one runner claims a job, and a finished job always has an event', async (t) => {
  const { base, jobs } = await store(t)
  const job = jobs.create({ root: base, session: 's1', spec })
  assert.equal(jobs.claim(job.id, process.pid), true)
  assert.equal(jobs.claim(job.id, process.pid), false)
  assert.deepEqual(jobs.pendingEvents('s1'), [])
  jobs.finish(job.id, 'done', { summary: 'Three files.' })
  const [event] = jobs.pendingEvents('s1')
  assert.equal(event?.job, job.id)
  jobs.acknowledge([event!.id])
  assert.deepEqual(jobs.pendingEvents('s1'), [])
  assert.equal(jobs.get(job.id).summary, 'Three files.')
})

test('a runner that died leaves its job for the host with an event', async (t) => {
  const { base, jobs } = await store(t)
  const job = jobs.create({ root: base, session: 's1', spec })
  jobs.claim(job.id, 2 ** 22 + 12345)
  assert.deepEqual(jobs.reconcile(), [], 'a fresh heartbeat is not yet silence')
  const [lost] = jobs.reconcile(Date.now() + jobLimits.staleMs + 1000)
  assert.equal(lost?.status, 'needs_attention')
  assert.match(lost!.error!, /runner stopped before finishing/)
  assert.equal(jobs.pendingEvents('s1').length, 1)
})

test('the user cancels; a queued job ends at once and a running one is signalled', async (t) => {
  const { base, jobs } = await store(t)
  const queued = jobs.create({ root: base, session: 's1', spec })
  assert.equal(jobs.requestCancel(queued.id).status, 'cancelled')
  const running = jobs.create({ root: base, session: 's1', spec })
  jobs.claim(running.id, process.pid)
  assert.equal(jobs.heartbeat(running.id), false)
  assert.equal(jobs.requestCancel(running.id).status, 'running')
  assert.equal(jobs.heartbeat(running.id), true)
  assert.throws(() => jobs.requeue(running.id), /only a stopped job can be retried/)
})

test('manual stop wins a pending model stop, including after a lost runner', async (t) => {
  const { base, jobs } = await store(t)
  const { id } = jobs.create({ root: base, session: 's1', spec })
  jobs.claim(id, 2 ** 22 + 12345)
  const first = jobs.requestCancel(id, 'Restart with corrected guidance.')
  assert.deepEqual(jobs.requestCancel(id, 'Repeated stop.'), first)
  const manual = jobs.requestCancel(id)
  assert.deepEqual(jobs.requestCancel(id, 'Override the stop.'), manual)
  const [lost] = jobs.reconcile(Date.now() + jobLimits.staleMs + 1)
  assert.equal(lost?.status, 'cancelled')
  assert.equal(lost.cancellation?.by, 'user')
  assert.throws(() => jobs.requeue(id, 'Ignore the user.'), /user stopped this job/)
  assert.deepEqual(jobs.takeMessages(id), [])
  assert.equal(jobs.pendingEvents('s1').length, 1)
})

test('a retry before feed delivery supersedes only the retried outcome', async (t) => {
  const { base, jobs } = await store(t)
  const { id } = jobs.create({ root: base, session: 's1', spec })
  const sibling = jobs.create({ root: base, session: 's1', spec })
  jobs.finish(sibling.id, 'done')
  assert.throws(() => jobs.requestCancel(id, '  '), /cancellation reason/)
  jobs.requestCancel(id, 'Correct the input.')
  assert.equal(jobs.claim(id, process.pid), false)
  jobs.requeue(id, 'New input.')
  assert.equal(jobs.claim(id, process.pid), true)
  assert.equal(jobs.claim(id, process.pid), false)
  assert.deepEqual(
    jobs.pendingEvents('s1').map((event) => event.job),
    [sibling.id],
  )
  assert.deepEqual(jobs.takeMessages(id), ['New input.'])
  jobs.requestCancel(id, 'Late stop during delivery.')
  const done = jobs.finish(id, 'done', { summary: 'Already delivered.' })
  assert.equal(done.status, 'done')
  assert.deepEqual(jobs.requestCancel(id, 'Too late.'), done)
  assert.throws(() => jobs.requeue(id), /is done/)
})

test('guidance is handed to a round exactly once', async (t) => {
  const { base, jobs } = await store(t)
  const job = jobs.create({ root: base, session: 's1', spec })
  jobs.addMessage(job.id, 'Count hidden files too.')
  assert.deepEqual(jobs.takeMessages(job.id), ['Count hidden files too.'])
  assert.deepEqual(jobs.takeMessages(job.id), [])
})

test('state written by another schema version is set aside, never migrated', async (t) => {
  const { base, jobs } = await store(t)
  jobs.create({ root: base, session: 's1', spec })
  jobs.close()
  const path = join(base, 'state', 'jobs.db')
  const old = new DatabaseSync(path)
  old.exec(`PRAGMA user_version = ${schemaVersion + 1}`)
  old.close()
  const fresh = new JobStore(base, join(base, 'state'))
  t.after(() => fresh.close())
  assert.deepEqual(fresh.list(), [])
  assert.ok((await readdir(join(base, 'state'))).includes(`jobs.db.v${schemaVersion + 1}`))
})
