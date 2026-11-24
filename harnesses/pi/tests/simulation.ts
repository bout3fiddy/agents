import assert from 'node:assert/strict'

// Seeded simulations share one replay convention. PI_SIMULATION_SEED=<seed> replays one failing
// seed; PI_SIMULATION_SEEDS=<count> widens a run beyond each test's fast default.
export function simulationSeeds(defaultCount: number): number[] {
  assert.ok(Number.isSafeInteger(defaultCount) && defaultCount > 0, 'default seed count')
  const only = process.env.PI_SIMULATION_SEED
  const count = Number(process.env.PI_SIMULATION_SEEDS ?? defaultCount)

  if (only !== undefined && only !== '') {
    const seed = Number(only)
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, `invalid PI_SIMULATION_SEED: ${only}`)
    return [seed]
  }

  assert.ok(Number.isSafeInteger(count) && count > 0, `invalid PI_SIMULATION_SEEDS: ${count}`)
  return Array.from({ length: count }, (_, index) => index + 1)
}

/** mulberry32: small, fast and fully determined by its seed. */
export function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks one item; a seeded draw keeps the choice replayable. */
export function pick<T>(next: () => number, items: readonly T[]): T {
  assert.ok(items.length > 0, 'pick requires at least one item')
  const index = Math.floor(next() * items.length)
  assert.ok(index >= 0 && index < items.length, 'seeded index stays in range')
  return items[index]!
}
