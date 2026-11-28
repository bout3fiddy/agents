import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { install } from '../scripts/install.ts'
import { HandoffStore, leaseMs, type Intent } from '../src/handoff-store.ts'
import { Receiver } from '../src/handoff-receiver.ts'
import { jobStore, startScopedJob } from '../src/job-tools.ts'
import { shellQuote } from '../src/pi-host.ts'
import { harnessRoot } from '../src/project.ts'
import { fixture } from './support.ts'

const exec = promisify(execFile)

test('private admission, dead owners, conflicting keys and side-effect-free probes', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const agent = join(base, 'agent')
  const source = join(base, 'source')
  await mkdir(source)
  let now = 1
  assert.equal(HandoffStore.open(agent), undefined)
  assert.ok(!existsSync(agent))
  const mail = HandoffStore.open(agent, true, () => now)!
  t.after(() => mail.close())
  assert.throws(() => mail.enroll(base, 'parent'), /private agent/)
  assert.throws(() => mail.enroll(agent, 'private'), /private agent/)
  mail.enroll(source, 'source')
  mail.enroll(root, 'destination')
  assert.ok(!existsSync(join(agent, 'harness-trust.json')))
  let launches = 0
  let token = ''
  const canonical = await realpath(root)
  const launch = (cwd: string, generation: string) => {
    assert.equal(cwd, canonical)
    launches++
    token = generation
    return process.pid
  }
  const send = (key: string, brief = 'Discuss', dest = 'destination', intent: Intent = 'discuss') =>
    mail.send(source, 'session', dest, key, intent, brief, launch)
  assert.throws(() => send('', ''))
  assert.throws(() => send('k', 'x', root))
  assert.throws(() => send('k', 'x', 'source'))
  assert.throws(() => send('k', 'x', 'destination', 'publish' as Intent))
  assert.throws(() => mail.send(base, 'session', 'destination', 'k', 'build', 'x', launch))
  assert.equal(launches, 0)
  const first = send('k')
  assert.equal(send('k'), first)
  assert.throws(() => send('k', 'Altered'), /different content/)
  assert.equal(mail.list()[0]?.presence, 'starting')
  assert.equal(mail.claim('destination', token), undefined, 'starting is not ready')
  assert.ok(!mail.heartbeat(root, 'wrong', true))
  assert.ok(mail.heartbeat(root, token, true))
  assert.equal(mail.claim('destination', token)?.id, first)
  assert.throws(() => mail.observe(root, first), /Unknown request/)
  now += leaseMs
  assert.equal(mail.observe(source, first).state, 'interrupted')
  assert.equal(mail.list()[0]?.presence, 'offline')
  assert.equal(launches, 1)
  const stale = token
  send('second')
  assert.equal(launches, 2)
  assert.equal(mail.observe(source, first).state, 'failed')
  assert.ok(!mail.claim('destination', stale))
  assert.throws(() => mail.attach(first, 'lost'), /lost its receiver/)
  mail.forget(source, first)
  assert.throws(() => mail.observe(source, first))
  now += leaseMs
  const failed = mail.send(source, 'session', 'destination', 'bad', 'build', 'x', () => {
    throw new Error('fixture spawn failure')
  })
  assert.match(mail.observe(source, failed).reply!, /Launch failed/)
  const settled = mail.recent('source', 'session')
  assert.equal(settled.length, 2)
  assert.throws(() => mail.leave(root, 'destination'), /retained/)

  for (const { id } of settled) {
    mail.forget(source, id)
  }

  mail.leave(root, 'destination')
  assert.throws(() => send('again'), /enrolled/)
  await chmod(join(agent, 'handoffs-v1'), 0o755)
  assert.throws(() => HandoffStore.open(agent), /private/)
})

test('full admission still returns existing IDs and never launches for overflow', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const mail = HandoffStore.open(join(base, 'agent'), true, () => 1)!
  t.after(() => mail.close())
  const source = join(base, 'source')
  await mkdir(source)
  mail.enroll(source, 'source')
  mail.enroll(root, 'target')
  let launches = 0
  const send = (n: number) =>
    mail.send(source, 'session', 'target', String(n), 'discuss', 'brief', () => {
      launches++
      return process.pid
    })
  const first = send(0)

  for (let i = 1; i < 1024; i++) {
    send(i)
  }

  assert.equal(send(0), first)
  assert.throws(() => send(1024), /Mailbox full/)
  assert.equal(launches, 1)
})

test('seeded owner turnover never claims an admitted request twice', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  let now = 1
  const db = HandoffStore.open(join(base, 'agent'), true, () => now)!
  t.after(() => db.close())
  const source = join(base, 'source')
  await mkdir(source)
  db.enroll(source, 's')
  db.enroll(root, 'd')
  const seed = Number(process.env.PI_TEST_HANDOFF_SEED ?? 2187)
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state
  }
  let token = 'owner-0'
  const ids = new Map<string, string>()
  const claimed = new Set<string>()

  for (let step = 0; step < 80; step++) {
    if (next() % 5 === 0) {
      now += leaseMs
      token = `owner-${step + 1}`
    }

    assert.ok(db.heartbeat(root, token, false), `seed ${seed} step ${step}`)
    const key = String(next() % 17)
    const id = db.send(source, 'session', 'd', key, 'discuss', 'Brief ' + key, () => {
      throw new Error('Live receiver must be reused')
    })
    assert.equal(id, ids.get(key) ?? id)
    ids.set(key, id)

    if (next() % 3 !== 0) {
      const r = db.claim('d', token)

      if (r) {
        assert.ok(!claimed.has(r.id), `duplicate in seed ${seed} step ${step}`)
        claimed.add(r.id)

        if (next() % 4 !== 0) {
          db.finish(r.id, 'done', 'Reply ' + r.key)
        }
      }
    }
  }

  now += leaseMs
  assert.ok(db.heartbeat(root, 'final', false))

  for (const [key, id] of ids) {
    const result = db.observe(source, id)
    assert.ok(['done', 'failed'].includes(result.state), `unsettled ${key} seed ${seed}`)

    if (result.state === 'done') {
      assert.equal(result.reply, 'Reply ' + key)
    }
  }
})

test('a replacement receiver collects the job without replaying the turn', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const agent = join(base, 'agent')
  const source = join(base, 'source')
  await mkdir(source)
  let now = 1
  const mail = HandoffStore.open(agent, true, () => now)!
  mail.enroll(source, 's')
  mail.enroll(root, 'd')
  assert.ok(mail.heartbeat(root, 'first', false))
  const id = mail.send(source, 'source-session', 'd', 'k', 'build', 'Set the value', () => {
    throw new Error('Unexpected launch')
  })
  assert.equal(mail.claim('d', 'first')?.id, id)
  const job = await startScopedJob(
    {
      title: 'Set',
      task: 'Set value',
      writePaths: ['src/value.js'],
      mode: 'implement',
      key: id,
      isolation: 'required',
    },
    root,
    id,
    'test/test',
    async (store, jobId) => {
      assert.ok(store.claim(jobId, process.pid))
    },
    (created) => mail.attach(id, created.id),
  )
  mail.close()
  now += leaseMs
  jobStore(root).finish(job.id, 'needs_attention', { error: 'Stopped by fixture.' })
  const next = HandoffStore.open(agent, false, () => now)!
  const replacement = new Receiver(next, root, 'd', 'next', async () =>
    assert.fail('Replayed a turn'),
  )

  try {
    assert.equal(next.observe(source, id).state, 'job')
    assert.ok(replacement.tick(false))
    assert.match(next.observe(source, id).reply!, /Stopped by fixture/)
    assert.deepEqual(
      next.recent('s', 'source-session').map((row) => row.id),
      [id],
    )
    assert.equal(jobStore(root).list().length, 1)
  } finally {
    await replacement.close()
  }
})

async function coldSend(t: TestContext, blocked: boolean) {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const agentDir = join(base, 'agent')
  const source = join(base, 'source')
  await mkdir(source)
  const { wrapper } = await install(agentDir)
  const env = {
    ...process.env,
    HOME: base,
    PI_CODING_AGENT_DIR: agentDir,
    PI_HARNESS_AGENT_DIR: agentDir,
    HANDOFF_TEST_CREDENTIAL: 'must not cross',
  }
  const run = (cwd: string, bin: string, args: string[]) =>
    exec(bin, args, { cwd, env, timeout: 30000 })
  await Promise.all(
    [root, source].map(async (cwd) => {
      await run(cwd, 'git', ['init', '-q', '--template=', '-b', 'main'])
      await run(cwd, 'git', ['add', '-A'])
      await run(cwd, 'git', [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.org',
        'commit',
        '-qm',
        'initial',
        '--allow-empty',
      ])
      await run(cwd, wrapper, ['project-enroll', cwd === root ? 'receiver' : 'sender'])
    }),
  )
  const mail = HandoffStore.open(agentDir)!
  t.after(() => mail.close())
  assert.deepEqual(
    mail.list().map((p) => p.presence),
    ['offline', 'offline'],
  )
  const shim = join(base, 'scripted-pih')
  const launches = join(base, 'launches')
  const log = join(base, 'launcher.log')
  const provider = pathToFileURL(join(harnessRoot, 'tests/handoff-model.ts')).href
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'set -eu',
      `echo launched >> ${shellQuote(launches)}`,
      'test -z "${HANDOFF_TEST_CREDENTIAL:-}"',
      'test -z "${NODE_OPTIONS:-}"',
      `test "$HOME" = ${shellQuote(join(await realpath(agentDir), 'handoffs-v1'))}`,
      `test "$(pwd -P)" = ${shellQuote(await realpath(root))}`,
      `export NODE_OPTIONS=${shellQuote('--import=' + provider)}`,
      `export TMPDIR=${shellQuote(base)}`,
      `exec ${shellQuote(wrapper)} "$@" >${shellQuote(log)} 2>&1`,
    ].join('\n'),
    { mode: 0o700 },
  )
  const send = async (key: string) =>
    (
      await run(source, process.execPath, [
        '--import',
        join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
        join(harnessRoot, 'tests/handoff-sender.ts'),
        agentDir,
        shim,
        key,
      ])
    ).stdout.trim()
  const [build, duplicate] = await Promise.all([send('build'), send('build')])
  assert.equal(build, duplicate)
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 1200 && !condition(); i++) {
      await delay(25)
    }

    assert.ok(
      condition(),
      JSON.stringify(mail.observe(source, build)) + ' ' + (await readFile(log, 'utf8')),
    )
  }
  await waitFor(() => mail.observe(source, build).state === 'handling')
  assert.equal(mail.list()[0]?.presence, 'live')
  const discuss = await send('discussion')
  assert.equal(mail.observe(source, discuss).state, 'queued')
  assert.equal((await readFile(launches, 'utf8')).trim(), 'launched')

  if (blocked) {
    await writeFile(join(agentDir, 'blocked'), 'worker needs input')
  }

  await writeFile(join(agentDir, 'released'), 'go')
  await waitFor(() => ['done', 'failed'].includes(mail.observe(source, build).state))
  const reply = mail.observe(source, build)
  assert.equal(reply.state, blocked ? 'failed' : 'done', JSON.stringify(reply))
  const recorded = jobStore(root).get(reply.job!)
  assert.equal(recorded.status, blocked ? 'needs_attention' : 'done')
  assert.deepEqual(recorded.spec.writePaths, ['src/value.js'])
  assert.equal(recorded.spec.isolation, 'required')
  assert.equal(recorded.session, build)

  if (blocked) {
    assert.match(reply.reply!, /Fixture needs a dependency/)
  } else {
    assert.ok(recorded.result.checks?.some((c) => c.check === 'contract' && c.status === 'passed'))
  }

  assert.equal(
    await readFile(join(root, 'src/value.js'), 'utf8'),
    `export const value = ${blocked ? 0 : 1}\n`,
  )
  await waitFor(() => mail.observe(source, discuss).state === 'done')
  assert.match(mail.observe(source, discuss).reply!, /Discussion reply/)
  await waitFor(() => mail.list()[0]?.presence === 'offline')
  assert.equal(jobStore(root).list().length, 1)
}

test(
  'concurrent cold send returns the checked job after both source hosts exit',
  { timeout: 90000 },
  (t) => coldSend(t, false),
)
test(
  'blocked cold job returns the blocker; the same receiver drains discussion mail',
  { timeout: 90000 },
  (t) => coldSend(t, true),
)
