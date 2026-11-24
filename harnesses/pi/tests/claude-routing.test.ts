import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { quotaMaxAgeMs, routeClaude } from '../src/claude-routing.ts'
import { ProviderQuotaError, type ModelRoute, type Role } from '../src/contracts.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'
import { generator, pick, simulationSeeds } from './simulation.ts'

test('Fable quota shares cooldown and restores preference after reset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('performance')
  const reset = Date.now() + 30000
  const calls: string[] = []
  const run = () =>
    routeClaude(
      role,
      async (selected) => {
        calls.push(selected.model)
        assert.deepEqual(selected, { ...role, model: selected.model })

        if (selected.model === role.model) {
          throw new ProviderQuotaError('usage', reset)
        }

        return selected.model
      },
      directory,
    )
  assert.equal(await run(), 'opus')
  assert.equal(await run(), 'opus')
  assert.deepEqual(calls, [role.model, 'opus', 'opus'])
  await assert.rejects(
    routeClaude(
      role,
      async () => {
        throw new ProviderQuotaError('opus limit', reset + 60000)
      },
      directory,
    ),
    (error) => error instanceof ProviderQuotaError && error.retryAt === reset,
  )
  await atomicJson(join(directory, 'quota', role.model + '.json'), { retryAt: Date.now() - 100 })
  assert.equal(await routeClaude(role, async (selected) => selected.model, directory), role.model)
  const fault = new Error('login required')
  await assert.rejects(
    routeClaude(
      role,
      async (selected) => {
        assert.equal(selected.model, role.model)
        throw fault
      },
      directory,
    ),
    (error) => error === fault,
  )
})

test('only a recent versioned confirmation authorizes a cached fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-reprobe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('design-advisor')
  const path = join(directory, 'quota', role.model + '.json')
  const now = Date.UTC(2026, 10, 23)
  const retryAt = now + 86400000
  const receipt = { version: 1, confirmedAt: now, retryAt }
  const probe = () =>
    routeClaude(
      role,
      async (_, __, route) => route,
      directory,
      () => now,
    )

  for (const invalid of [
    { retryAt },
    { ...receipt, version: 2 },
    { ...receipt, confirmedAt: now - quotaMaxAgeMs },
    { ...receipt, confirmedAt: now + 1 },
    { ...receipt, retryAt: now },
    { ...receipt, retryAt: String(retryAt) },
    { ...receipt, retryAt: Number.MAX_SAFE_INTEGER },
    { ...receipt, confirmedAt: now - 0.5 },
    null,
  ]) {
    await atomicJson(path, invalid)
    assert.deepEqual(await probe(), { requestedModel: role.model, actualModel: role.model })
    await assert.rejects(readFile(path), { code: 'ENOENT' })
  }

  await writeFile(path, '{')
  assert.equal((await probe()).actualModel, role.model)
  const limit = new ProviderQuotaError('quota', retryAt)
  const confirmed = await routeClaude(
    role,
    async (selected, _, route) => {
      if (selected.model === role.model) {
        throw limit
      }

      return route
    },
    directory,
    () => now,
  )
  assert.deepEqual(confirmed, {
    requestedModel: role.model,
    actualModel: 'opus',
    fallbackReason: 'quota-confirmed',
    confirmedAt: now,
    retryAt,
  })
  assert.deepEqual(await probe(), { ...confirmed, fallbackReason: 'quota-cached' })
  const restored = await routeClaude(
    role,
    async (selected) => selected.model,
    directory,
    () => now + quotaMaxAgeMs,
  )
  assert.equal(restored, role.model)
  await assert.rejects(readFile(path), { code: 'ENOENT' })

  for (const invalidReset of [Infinity, NaN, retryAt + 0.25, now - 1]) {
    const invalid = new ProviderQuotaError('invalid reset', invalidReset)
    await assert.rejects(
      routeClaude(
        role,
        async (selected) => {
          assert.equal(selected.model, role.model)
          throw invalid
        },
        directory,
        () => now,
      ),
      (error) => error === invalid,
    )
  }
})

test('Fable writers retain effort and scope on quota fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-writer-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const defaultRole = await loadRole('implementer')
  assert.equal(defaultRole.model, 'openai-codex/gpt-6.2-astra')

  for (const selection of ['fable', 'opus'] as const) {
    const role = await loadRole('implementer', 'high', selection)
    const model = selection === 'opus' ? 'claude-opus-5-5' : 'claude-fable-5-2'
    assert.deepEqual(role, {
      ...defaultRole,
      backend: 'claude-cli',
      model,
      thinking: 'high',
      tools: defaultRole.tools.filter((tool) => tool !== 'codemode'),
    })
    const attempts: string[] = []
    const limit = new ProviderQuotaError('quota', Date.now() + 60000)
    const run = () =>
      routeClaude(
        role,
        async (selected, retry) => {
          attempts.push(selected.model)
          assert.deepEqual(selected, { ...role, model: selected.model })

          if (selected.model === 'opus') {
            return retry
          }

          throw limit
        },
        directory,
      )

    if (selection === 'fable') {
      assert.equal(await run(), true)
      assert.equal(await run(), false)
      assert.deepEqual(attempts, [model, 'opus', 'opus'])
    } else {
      await assert.rejects(run(), (error) => error === limit)
      assert.deepEqual(attempts, [model])
    }

    await assert.rejects(loadRole('performance', 'medium', selection), /implementer role/)
    await assert.rejects(loadRole('implementer', 'low', selection), /Unsupported thinking/)
  }
})

test('quota receipts admit the last valid millisecond and reject the first stale', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-boundary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('design-advisor')
  const path = join(directory, 'quota', role.model + '.json')
  const now = Date.UTC(2026, 10, 24)
  const cases = [
    { confirmedAt: now, retryAt: now + 1, cached: true },
    { confirmedAt: now - quotaMaxAgeMs + 1, retryAt: now + 1, cached: true },
    { confirmedAt: now - quotaMaxAgeMs, retryAt: now + 1, cached: false },
    { confirmedAt: now + 1, retryAt: now + 2, cached: false },
    { confirmedAt: now - 1, retryAt: now, cached: false },
  ]

  for (const { cached, ...times } of cases) {
    await atomicJson(path, { version: 1, ...times })
    const attempts: string[] = []
    const route = await routeClaude(
      role,
      async (selected, retry, selectedRoute) => {
        attempts.push(selected.model)
        assert.equal(retry, false)
        return selectedRoute
      },
      directory,
      () => now,
    )
    const label = JSON.stringify(times)
    const preferred = { requestedModel: role.model, actualModel: role.model }
    const fallback = { ...preferred, actualModel: 'opus', fallbackReason: 'quota-cached', ...times }
    assert.deepEqual(attempts, [cached ? 'opus' : role.model], label)
    assert.deepEqual(route, cached ? fallback : preferred, label)
  }

  await rm(path, { force: true })

  for (const [retryAt, confirmed] of [
    [now + 1, true],
    [now, false],
  ] as const) {
    const limit = new ProviderQuotaError('quota', retryAt)
    const routed = routeClaude(
      role,
      async (selected, retry, selectedRoute) => {
        if (selected.model === role.model) {
          throw limit
        }

        assert.equal(retry, true)
        return selectedRoute
      },
      directory,
      () => now,
    )

    if (confirmed) {
      assert.equal((await routed).fallbackReason, 'quota-confirmed')
      const receipt = JSON.parse(await readFile(path, 'utf8'))
      assert.deepEqual(receipt, { version: 1, confirmedAt: now, retryAt })
      await rm(path)
    } else {
      await assert.rejects(routed, (error) => error === limit)
      await assert.rejects(readFile(path), { code: 'ENOENT' })
    }
  }
})

// Concurrent routing simulation. Calls share one receipt directory and a simulated clock. Exactly
// one call advances between quiescent points, so a seed fully determines the interleaving of
// launches, clock steps and attempt outcomes. Replay with PI_SIMULATION_SEED=<seed>.
const routingStart = Date.UTC(2026, 10, 24)
const routingSteps = 24
const maxRoutingCalls = 6
const maxPendingAttempts = 4
const clockSteps = [1, 60_000, quotaMaxAgeMs - 1, quotaMaxAgeMs, 3_600_000]
const resetOffsets = [1, 60_000, quotaMaxAgeMs + 1, 3_600_000]
const outcomes = ['success', 'quota', 'stale-quota', 'fault'] as const

type Outcome = (typeof outcomes)[number]
type QuotaFile = { version: number; confirmedAt: number; retryAt: number }
type Pending = {
  call: number
  route: ModelRoute
  resolve: (value: string) => void
  reject: (error: unknown) => void
}
type Call = {
  id: number
  routes: ModelRoute[]
  startedWithReceipt: boolean
  settled: boolean
  value?: string
  error?: unknown
  progress: Promise<void>
  wake: () => void
  done?: Promise<void>
}

function arm(call: Call) {
  call.progress = new Promise((resolve) => {
    call.wake = () => resolve()
  })
}

class RoutingSimulation {
  readonly calls: Call[] = []
  readonly pending: Pending[] = []
  readonly coverage = { cached: 0, confirmed: 0, recovered: 0, combined: 0 }
  readonly path: string
  clock = routingStart

  constructor(
    readonly role: Role,
    readonly directory: string,
    readonly next: () => number,
  ) {
    this.path = join(directory, 'quota', role.model + '.json')
  }

  async receipt(): Promise<QuotaFile | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as QuotaFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      // No receipt is a valid state: Fable is preferred.
      return undefined
    }
  }

  /** Oracle for the documented contract: reuse only before reset and within the maximum age. */
  fresh(receipt: QuotaFile | undefined): receipt is QuotaFile {
    return (
      receipt?.version === 1 &&
      receipt.confirmedAt <= this.clock &&
      this.clock - receipt.confirmedAt < quotaMaxAgeMs &&
      this.clock < receipt.retryAt
    )
  }

  async checkReceipt() {
    const receipt = await this.receipt()

    if (receipt !== undefined) {
      assert.equal(receipt.version, 1)
      assert.ok(Number.isSafeInteger(receipt.confirmedAt) && Number.isSafeInteger(receipt.retryAt))
      assert.ok(receipt.confirmedAt <= this.clock, 'a receipt never comes from the future')
      assert.ok(receipt.confirmedAt < receipt.retryAt, 'a receipt resets after confirmation')
    }
  }

  attempt(call: Call, selected: Role, retry: boolean, route: ModelRoute): Promise<string> {
    const { role } = this
    assert.deepEqual(selected, { ...role, model: selected.model }, 'only the model changes')
    assert.equal(route.requestedModel, role.model)
    assert.equal(route.actualModel, selected.model, 'the route attributes the invoked model')
    assert.equal(route.fallbackReason !== undefined, selected.model === 'opus')
    assert.equal(retry, route.fallbackReason === 'quota-confirmed')
    assert.ok(call.routes.length < 2, 'a call makes at most one fallback attempt')
    assert.ok(call.routes.length === 0 || selected.model === 'opus', 'only Opus follows Fable')
    call.routes.push(route)
    return new Promise((resolve, reject) => {
      this.pending.push({ call: call.id, route, resolve, reject })
      call.wake()
    })
  }

  async launch() {
    const receipt = await this.receipt()
    const cached = this.fresh(receipt)
    const call: Call = {
      id: this.calls.length,
      routes: [],
      startedWithReceipt: receipt !== undefined,
      settled: false,
      progress: Promise.resolve(),
      wake: () => {},
    }
    arm(call)
    this.calls.push(call)
    const { role, directory } = this
    const attempt = (selected: Role, retry: boolean, route: ModelRoute) =>
      this.attempt(call, selected, retry, route)
    call.done = routeClaude(role, attempt, directory, () => this.clock)
      .then(
        (value) => {
          call.value = value
        },
        (error: unknown) => {
          call.error = error
        },
      )
      .finally(() => {
        call.settled = true
        call.wake()
      })
    await call.progress
    const preferred = { requestedModel: role.model, actualModel: role.model }
    assert.equal(call.settled, false, 'a launched call attempts a model before settling')

    if (cached && receipt) {
      this.coverage.cached++
      const { confirmedAt, retryAt } = receipt
      const reused = { requestedModel: role.model, actualModel: 'opus', confirmedAt, retryAt }
      assert.deepEqual(call.routes, [{ ...reused, fallbackReason: 'quota-cached' }])
    } else {
      this.coverage.recovered += receipt === undefined ? 0 : 1
      assert.deepEqual(call.routes, [preferred], 'without a fresh receipt Fable is probed')
    }
  }

  async settle(index: number, forced?: Outcome) {
    const [attempt] = this.pending.splice(index, 1)
    assert.ok(attempt, 'a pending attempt exists')
    const call = this.calls[attempt.call]!
    const outcome = forced ?? pick(this.next, outcomes)
    const resetAt = this.clock + (outcome === 'stale-quota' ? 0 : pick(this.next, resetOffsets))
    const fault = new Error(`simulated fault ${call.id}`)
    const limit = new ProviderQuotaError(`simulated limit ${call.id}`, resetAt)
    const before = await this.receipt()
    arm(call)

    if (outcome === 'success') {
      attempt.resolve(`call ${call.id}`)
    } else {
      attempt.reject(outcome === 'fault' ? fault : limit)
    }

    await call.progress
    const fable = attempt.route.actualModel === this.role.model

    if (outcome === 'quota' && fable) {
      await this.expectConfirmed(call, resetAt)
    } else if (outcome === 'success') {
      assert.equal(call.value, `call ${call.id}`)
      const after = await this.receipt()
      const kept = after === undefined || this.fresh(after) || !call.startedWithReceipt
      assert.ok(!fable || kept, 'a Fable success clears a stale receipt it observed')
    } else if (fable || outcome === 'fault') {
      assert.equal(call.error, outcome === 'fault' ? fault : limit, 'errors propagate unchanged')
      assert.deepEqual(await this.receipt(), before, 'a rejected outcome leaves the receipt')
    } else {
      this.expectCombined(call, attempt.route, resetAt)
    }

    assert.equal(call.settled, outcome !== 'quota' || !fable)
  }

  async expectConfirmed(call: Call, retryAt: number) {
    const confirmedAt = this.clock
    const { role } = this
    const route = { requestedModel: role.model, actualModel: 'opus', confirmedAt, retryAt }
    assert.deepEqual(call.routes.at(-1), { ...route, fallbackReason: 'quota-confirmed' })
    assert.deepEqual(await this.receipt(), { version: 1, confirmedAt, retryAt })
    this.coverage.confirmed++
  }

  expectCombined(call: Call, route: ModelRoute, resetAt: number) {
    assert.ok(call.error instanceof ProviderQuotaError, 'Opus exhaustion stays a quota error')
    assert.match(call.error.message, /^Fable and Opus have reached their usage limits/)
    assert.equal(call.error.retryAt, Math.min(route.retryAt!, resetAt))
    this.coverage.combined++
  }
}

async function routingScenario(t: TestContext, seed: number) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-simulation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const next = generator(seed)
  const simulation = new RoutingSimulation(await loadRole('design-advisor'), directory, next)
  const { pending, calls } = simulation

  for (let step = 0; step < routingSteps; step++) {
    const launchable = calls.length < maxRoutingCalls && pending.length < maxPendingAttempts
    const action = pick(next, launchable ? ['launch', 'settle', 'advance'] : ['settle', 'advance'])

    if (action === 'launch') {
      await simulation.launch()
    } else if (action === 'settle' && pending.length) {
      await simulation.settle(pick(next, [...pending.keys()]))
    } else {
      simulation.clock += pick(next, clockSteps)
    }

    await simulation.checkReceipt()
  }

  // Each call makes at most two attempts, so draining is bounded by twice the call count.
  for (let drained = 0; pending.length; drained++) {
    assert.ok(drained < 2 * maxRoutingCalls, `seed ${seed}: draining terminates`)
    await simulation.settle(0)
    await simulation.checkReceipt()
  }

  await Promise.all(calls.map((call) => call.done))
  assert.ok(calls.every((call) => call.settled))

  // Preference recovery: after every reset and confirmation window, Fable is probed first again.
  simulation.clock += Math.max(...resetOffsets) + quotaMaxAgeMs
  await simulation.launch()
  await simulation.settle(0, 'success')
  assert.equal(await simulation.receipt(), undefined, `seed ${seed}: recovery clears the receipt`)
  return simulation.coverage
}

test('seeded concurrent routing keeps attribution, confirmation and Fable recovery', async (t) => {
  const seeds = simulationSeeds(16)
  const total = { cached: 0, confirmed: 0, recovered: 0, combined: 0 }

  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async (st) => {
      const coverage = await routingScenario(st, seed)

      for (const key of Object.keys(total) as (keyof typeof total)[]) {
        total[key] += coverage[key]
      }
    })
  }

  // The default seed set must reach every routing state; a vacuous schedule proves nothing.
  if (seeds.length >= 16) {
    for (const [state, count] of Object.entries(total)) {
      assert.ok(count > 0, `simulation never reached ${state}`)
    }
  }
})
