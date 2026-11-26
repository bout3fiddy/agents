// Runs without packages: node --experimental-strip-types --test tests/coordinator-swarm.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ActiveSiblings,
  capacityFailure,
  dispatchSwarm,
  duplicateIds,
  researcherIdPattern,
  swarmReport,
  type SwarmOutcome,
} from '../src/coordinator-swarm.ts'

type Member = { id: string }

function group(size: number): Member[] {
  return Array.from({ length: size }, (_, index) => ({ id: `r${index}` }))
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function systemError(code: string): Error {
  return Object.assign(new Error(`spawn ${code}`), { code })
}

/** Let already-scheduled promise reactions run without relying on wall-clock time. */
async function drain() {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// Deterministic generator for replayable schedules.
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

test('every researcher starts before any is released, at any chosen group size', async () => {
  for (const size of [1, 2, 7, 64, 300]) {
    const barrier = gate()
    let started = 0
    let finished = 0
    const running = dispatchSwarm(
      group(size),
      async (member) => {
        started++
        await barrier.opened
        finished++
        return `${member.id} findings`
      },
      new AbortController().signal,
    )

    // No await has happened yet: the whole group is already running and nothing is queued.
    assert.equal(started, size)
    await drain()
    assert.equal(finished, 0)
    barrier.open()
    const outcomes = await running
    assert.equal(finished, size)
    assert.deepEqual(
      outcomes,
      group(size).map(({ id }) => ({ id, status: 'completed', value: `${id} findings` })),
    )
  }
})

test('a failing researcher is its own outcome and siblings still finish', async () => {
  const barrier = gate()
  let settledSwarm = false
  const running = dispatchSwarm(
    [{ id: 'slow' }, { id: 'no-process' }, { id: 'refused' }, { id: 'broken' }, { id: 'quota' }],
    (member) => {
      if (member.id === 'refused') {
        throw systemError('EMFILE')
      }

      if (member.id === 'no-process') {
        return Promise.reject(systemError('EAGAIN'))
      }

      if (member.id === 'broken') {
        return Promise.reject(new Error('Worker exited without a result'))
      }

      if (member.id === 'quota') {
        return Promise.reject(Object.assign(new Error('Usage limit reached'), { retryAt: 99 }))
      }

      return barrier.opened.then(() => 'slow findings')
    },
    new AbortController().signal,
  ).finally(() => {
    settledSwarm = true
  })
  await drain()

  // Four researchers already failed; the swarm still holds until its last sibling settles.
  assert.equal(settledSwarm, false)
  barrier.open()
  const outcomes = await running
  assert.deepEqual(
    outcomes.map((outcome) => [
      outcome.id,
      outcome.status,
      outcome.status === 'failed' && outcome.capacity,
    ]),
    [
      ['slow', 'completed', false],
      ['no-process', 'failed', true],
      ['refused', 'failed', true],
      ['broken', 'failed', false],
      ['quota', 'failed', true],
    ],
  )
  const report = swarmReport(outcomes)
  assert.deepEqual(report.swarm, { size: 5, completed: 1, failed: 4, capacityFailures: 3 })
  assert.deepEqual(report.unfinished, ['no-process', 'refused', 'broken', 'quota'])
  assert.match(report.instruction ?? '', /Nothing is queued/)
  assert.deepEqual(report.researchers[4], {
    id: 'quota',
    status: 'failed',
    capacity: true,
    error: 'Error: Usage limit reached',
    retryAt: 99,
  })
})

test('cancellation reaches every researcher and rejects after the last one stops', async () => {
  const controller = new AbortController()
  const reluctant = gate()
  const stopped: string[] = []
  let rejected = false
  const running = dispatchSwarm(
    group(4),
    (member) =>
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          const stop = () => {
            stopped.push(member.id)
            reject(new Error('Worker cancelled'))
          }

          if (member.id === 'r2') {
            void reluctant.opened.then(stop)
          } else {
            stop()
          }
        })
      }),
    controller.signal,
  ).catch((error: unknown) => {
    rejected = true
    throw error
  })
  const settled = assert.rejects(running, /Task cancelled by user/)
  controller.abort(new Error('Task cancelled by user'))
  await drain()
  assert.deepEqual(stopped, ['r0', 'r1', 'r3'])
  assert.equal(rejected, false)
  reluctant.open()
  await settled
  assert.deepEqual(stopped, ['r0', 'r1', 'r3', 'r2'])
})

test('a cancelled or malformed swarm starts no researcher', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Task paused for inspection'))
  let started = 0
  const start = async () => {
    started++
    return 'unreachable'
  }
  await assert.rejects(dispatchSwarm(group(3), start, controller.signal), /paused for inspection/)
  const live = new AbortController().signal
  await assert.rejects(dispatchSwarm([], start, live), /Invariant violated: .*at least one/)
  await assert.rejects(
    dispatchSwarm([{ id: 'a' }, { id: 'b' }, { id: 'a' }], start, live),
    /Invariant violated: .*unique/,
  )
  assert.equal(started, 0)
})

test('cancellation after the swarm settled keeps every completed outcome', async () => {
  const controller = new AbortController()
  const outcomes = await dispatchSwarm(group(2), async ({ id }) => id, controller.signal)
  controller.abort(new Error('late'))
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['completed', 'completed'],
  )
})

test('capacity failures are recognized by their actual cause', () => {
  for (const code of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOBUFS']) {
    assert.equal(capacityFailure(systemError(code)), true, code)
    assert.equal(capacityFailure(new Error('wrapped', { cause: systemError(code) })), true, code)
  }

  assert.equal(capacityFailure(Object.assign(new Error('quota'), { retryAt: 1 })), true)

  for (const ordinary of [
    new Error('Worker exited without a result'),
    systemError('ENOENT'),
    Object.assign(new Error('bad'), { retryAt: Number.NaN }),
    Object.assign(new Error('bad'), { retryAt: 'soon' }),
    new Error('deep', { cause: new Error('middle', { cause: systemError('EAGAIN') }) }),
    'EAGAIN',
    undefined,
    null,
    7,
  ]) {
    assert.equal(capacityFailure(ordinary), false, String(ordinary))
  }
})

test('researcher identities are short labels and duplicates are named', () => {
  const pattern = new RegExp(researcherIdPattern)

  for (const id of ['a', 'auth-flow', '2fa', 'x'.repeat(40)]) {
    assert.ok(pattern.test(id), id)
  }

  for (const id of ['', '-a', 'Auth', 'a b', 'a/b', 'x'.repeat(41)]) {
    assert.equal(pattern.test(id), false, id)
  }

  assert.deepEqual(duplicateIds(['b', 'a', 'b', 'c', 'a', 'a']), ['a', 'b'])
  assert.deepEqual(duplicateIds(['a', 'b']), [])
})

test('the report lists each researcher once and bounds failure text', () => {
  const complete = swarmReport<string>([{ id: 'only', status: 'completed', value: 'found' }])
  assert.deepEqual(complete, {
    swarm: { size: 1, completed: 1, failed: 0, capacityFailures: 0 },
    researchers: [{ id: 'only', status: 'completed', evidence: 'found' }],
    unfinished: [],
  })
  const failed = swarmReport<string>([
    { id: 'long', status: 'failed', capacity: false, error: new Error('x'.repeat(2000)) },
  ])
  const [entry] = failed.researchers
  assert.ok(entry?.status === 'failed')
  assert.equal(entry.error.length, 500)
  assert.equal('retryAt' in entry, false)
  assert.match(failed.instruction ?? '', /Dispatch each unfinished id again/)
  const twice: SwarmOutcome<string>[] = [
    { id: 'same', status: 'completed', value: 'one' },
    { id: 'same', status: 'completed', value: 'two' },
  ]
  assert.throws(() => swarmReport(twice), /Invariant violated: .*exactly once/)
})

test('same-role siblings keep distinct progress and never resurrect', () => {
  const siblings = new ActiveSiblings<{ role: string; tool: string }>()
  assert.equal(siblings.current(), undefined)
  siblings.start('first', { role: 'task-worker', tool: 'starting' })
  siblings.start('second', { role: 'task-worker', tool: 'starting' })
  assert.equal(siblings.size, 2)
  assert.equal(siblings.update('first', { role: 'task-worker', tool: 'project_read' }), true)
  assert.deepEqual(siblings.current(), { role: 'task-worker', tool: 'project_read' })
  siblings.finish('first')

  // The parent now points at the sibling that is still running, not at the finished one.
  assert.deepEqual(siblings.current(), { role: 'task-worker', tool: 'starting' })
  assert.equal(siblings.update('first', { role: 'task-worker', tool: 'late' }), false)
  assert.equal(siblings.size, 1)
  assert.throws(() => siblings.start('second', { role: 'task-worker', tool: 'again' }), /once/)
  assert.throws(() => siblings.finish('first'), /finishes once/)
  siblings.finish('second')
  assert.equal(siblings.current(), undefined)
  assert.equal(siblings.size, 0)
})

type Fate = 'completed' | 'failed' | 'capacity'

/** One generated swarm: random size, fates and settle order, all derived from the seed. */
async function simulate(seed: number) {
  const random = generator(seed)
  const size = 1 + Math.floor(random() * 40)
  const members = group(size)
  const fates = members.map((): Fate => {
    const draw = random()
    return draw < 0.6 ? 'completed' : draw < 0.8 ? 'failed' : 'capacity'
  })
  const releases: (() => void)[] = []
  let started = 0
  let settled = 0
  let startedAtFirstSettle = -1
  const running = dispatchSwarm(
    members,
    (member) => {
      const index = Number(member.id.slice(1))
      started++
      return new Promise<string>((resolve, reject) => {
        releases[index] = () => {
          if (settled++ === 0) {
            startedAtFirstSettle = started
          }

          if (fates[index] === 'completed') {
            resolve(member.id)
          } else {
            reject(fates[index] === 'capacity' ? systemError('EAGAIN') : new Error('defect'))
          }
        }
      })
    },
    new AbortController().signal,
  )
  const order = members.map((_, index) => index)

  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[order[index], order[other]] = [order[other]!, order[index]!]
  }

  for (const index of order) {
    releases[index]!()
    await Promise.resolve()
  }

  const outcomes = await running
  assert.equal(startedAtFirstSettle, size, `seed ${seed}: all start before any settles`)
  assert.equal(settled, size, `seed ${seed}: each researcher settles once`)
  assert.deepEqual(
    outcomes.map((outcome) => [
      outcome.id,
      outcome.status === 'completed' ? 'completed' : outcome.capacity ? 'capacity' : 'failed',
    ]),
    members.map((member, index) => [member.id, fates[index]]),
    `seed ${seed}: outcomes follow member order whatever the settle order`,
  )
  const report = swarmReport(outcomes)
  assert.equal(report.swarm.completed + report.unfinished.length, size, `seed ${seed}`)
  assert.equal(report.instruction === undefined, report.unfinished.length === 0, `seed ${seed}`)
}

test('seeded schedules keep one ordered outcome per researcher', async () => {

  // Replay one schedule with PI_SWARM_SEED=<n>; widen the sweep with PI_SWARM_SEEDS=<count>.
  const replay = process.env.PI_SWARM_SEED
  const count = Number(process.env.PI_SWARM_SEEDS ?? 200)
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100000)
  const seeds = replay === undefined ? Array.from({ length: count }, (_, seed) => seed) : [+replay]

  for (const seed of seeds) {
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, 'seed must be a non-negative integer')
    await simulate(seed)
  }
})
