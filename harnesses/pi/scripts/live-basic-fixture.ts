import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, atomicJson } from '../src/state.ts'

export async function basicFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-live-counter-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'tests'))
  await writeFile(
    join(root, 'src/count.mjs'),
    'export function parseCount(input) {\n  return parseInt(input, 10)\n}\n',
  )
  await writeFile(
    join(root, 'tests/count.mjs'),
    `import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCount } from '../src/count.mjs'

test('canonical counts round trip and malformed inputs fail', () => {
  let seed = 417

  for (let index = 0; index < 1000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const value = seed % 1000001
    assert.equal(parseCount(String(value)), value)
    assert.throws(() => parseCount(String(value) + 'x'))
    assert.throws(() => parseCount(' ' + value))
  }

  for (const value of [0, 1, 999999, 1000000]) {
    assert.equal(parseCount(String(value)), value)
  }

  for (const value of [null, undefined, {}, 1, '', '01', '-1', '+1', '1.0', '1000001']) {
    assert.throws(() => parseCount(value))
  }
})
`,
  )
  await atomicJson(join(root, '.pi/harness.json'), {
    checks: [
      {
        id: 'contract',
        kind: 'test',
        required: true,
        argv: ['node', '--test', 'tests/count.mjs'],
        timeoutMs: 10000,
      },
    ],
  })
  const store = new StateStore(root)
  const hash = await store.draft({
    objective: 'Validate a bounded canonical decimal count',
    design:
      'Export parseCount(input) from src/count.mjs. Accept strings containing canonical ' +
      'base-10 integers from 0 through 1000000 inclusive. Reject other types, whitespace, signs, ' +
      'leading zeroes except the value 0, fractions, suffixes and values outside that range. ' +
      'Return the numeric value or throw. Preserve the immutable external tests.',
    invariants: ['Invalid inputs throw without side effects'],
    acceptance: ['Seeded round trips and malformed inputs pass the immutable contract suite'],
    writePaths: ['src/count.mjs'],
    database: false,
    performance: false,
    unresolved: [],
  })
  return { root, store, hash }
}
