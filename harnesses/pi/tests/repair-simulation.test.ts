import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  delegationDirectory,
  emptyControls,
  type DelegationRequest,
} from '../src/delegation-state.ts'
import type { Dispatcher } from '../src/dispatch.ts'
import { gitCommand } from '../src/git-branches.ts'
import { runLocalCandidate } from '../src/local-candidate.ts'
import { inventory, snapshotHash } from '../src/paths.ts'
import { repairRoundsWithoutGuidance } from '../src/repair-budget.ts'
import { atomicJson } from '../src/state.ts'
import { branchRepository, completed } from './branch-support.ts'

// Seeded scenarios combine generated repository shapes with adverse implementer behavior. Every
// scenario must terminate within the repair bound; a completed task commits only its assigned
// paths. A failing seed reproduces with PI_SIMULATION_SEED=<seed>.
const only = process.env.PI_SIMULATION_SEED
const count = Number(process.env.PI_SIMULATION_SEEDS ?? 16)
const seeds = only ? [Number(only)] : Array.from({ length: count }, (_, index) => index + 1)
const behaviors = ['fix', 'noop', 'churn', 'outOfScope', 'blocked', 'crash'] as const

// Terminal behaviors end a scenario at once, so they are rarer; most rounds reach the gate.
const weights: Record<(typeof behaviors)[number], number> = {
  fix: 3,
  noop: 3,
  churn: 4,
  outOfScope: 1,
  blocked: 1,
  crash: 1,
}
const ignores = ['node_modules/', 'node_modules'] as const
const policies = ['plain', 'inherited', 'moving'] as const
const stopReasons = [
  /Repair made no progress/,
  /failed rounds without new guidance/,
  /Local implementer blocked/,
  /simulated worker crash/,
  /outside its assignment/,
  /Pinned local acceptance workload changed/,
]

type Behavior = (typeof behaviors)[number]

/** mulberry32: small, fast and fully determined by its seed. */
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!
}

function weighted(next: () => number): Behavior {
  const total = behaviors.reduce((sum, behavior) => sum + weights[behavior], 0)
  let point = next() * total

  for (const behavior of behaviors) {
    point -= weights[behavior]

    if (point < 0) {
      return behavior
    }
  }

  return behaviors[0]
}

const implementation = (extra: string[] = []) =>
  [
    'export const base = 1',
    '',
    'export function doubled(value) {',
    '  return value * 2',
    '}',
    ...extra,
    '',
  ].join('\n')

async function scenario(t: Parameters<typeof branchRepository>[0], seed: number) {
  const next = generator(seed)
  const ignore = pick(next, ignores)
  const policy = pick(next, policies)
  const trackedIgnored = next() < 0.5
  const plan: Behavior[] = Array.from({ length: repairRoundsWithoutGuidance + 1 }, () =>
    weighted(next),
  )
  const setup = await branchRepository(t)
  const root = setup.root
  const git = (args: string[]) => gitCommand(root, args)
  await git(['remote', 'remove', 'origin'])
  await git(['switch', '-c', 'cleanup'])
  await writeFile(
    join(root, 'acceptance.mjs'),
    "import assert from 'node:assert/strict'\nimport { doubled } from './src/one.js'\n\n" +
      'assert.equal(doubled(4), 8)\n',
  )
  await writeFile(join(root, '.gitignore'), `${ignore}\n${trackedIgnored ? 'vendored\n' : ''}`)
  const adapterPath = join(root, '.pi/harness.json')
  const adapter = JSON.parse(await readFile(adapterPath, 'utf8'))

  // The copy's Git view must show only the candidate's own change, whatever the repository shape.
  adapter.checks.push({
    id: 'git-view',
    argv: ['sh', '-c', 'test -z "$(git diff --name-only HEAD -- . \':!src/one.js\')"'],
    kind: 'static',
    required: true,
    timeoutMs: 10000,
  })

  if (policy === 'inherited') {
    await writeFile(join(root, 'legacy.txt'), 'inherited defect\n')
    adapter.checks.push({
      id: 'legacy',
      argv: ['node', '-e', "console.error('legacy.txt:1:1: inherited'); process.exit(1)"],
      kind: 'static',
      required: true,
      timeoutMs: 10000,
    })
  }

  if (policy === 'moving') {
    const moving =
      "const n = require('fs').readFileSync('src/one.js', 'utf8').split('\\n').length; " +
      "if (n < 40) { console.error('src/one.js:' + n + ': too short'); process.exit(1) }"
    adapter.checks.push({
      id: 'moving',
      argv: ['node', '-e', moving],
      kind: 'static',
      required: true,
      timeoutMs: 10000,
    })
  }

  await writeFile(adapterPath, JSON.stringify(adapter, null, 2) + '\n')

  if (trackedIgnored) {
    await mkdir(join(root, 'vendored'))
    await writeFile(join(root, 'vendored', 'pinned.json'), '{}\n')
    await git(['add', '-f', 'vendored/pinned.json'])
  }

  await git(['add', '-A'])
  await git(['commit', '-m', `Simulation seed ${seed}`])
  await mkdir(join(root, 'node_modules', 'pi-simulation'), { recursive: true })
  const base = await git(['rev-parse', 'HEAD'])
  const id = randomUUID()
  const request: DelegationRequest = {
    ...setup.origin,
    root: setup.store.projectRoot,
    id,
    kind: 'branch',
    task: 'Add doubled',
    context: 'Preserve the base export.',
    writePaths: ['src/one.js'],
    createdAt: new Date().toISOString(),
    local: {
      base,
      batch: randomUUID(),
      mode: 'independent',
      targetRef: 'refs/heads/cleanup',
      objective: 'Double an integer',
      workloadPaths: [],
      acceptance: {
        id: 'local-acceptance',
        kind: 'test',
        required: true,
        argv: ['node', 'acceptance.mjs'],
        timeoutMs: 5000,
      },
    },
  }
  const directory = delegationDirectory(setup.store, id)
  await atomicJson(join(directory, 'controls.json'), emptyControls)
  await atomicJson(join(directory, 'request.json'), request)
  await atomicJson(join(directory, 'status.json'), {
    id,
    status: 'queued',
    updatedAt: request.createdAt,
  })
  return { setup, request, plan, policy, base, git, ignore, trackedIgnored }
}

async function act(workspace: string, behavior: Behavior, round: number) {
  const path = join(workspace, 'src/one.js')

  if (behavior === 'crash') {
    throw new Error('simulated worker crash')
  }

  if (behavior === 'fix') {
    const filler = Array.from({ length: 40 }, (_, index) => `// note ${index}`)
    await writeFile(path, implementation(['', ...filler]))
  }

  if (behavior === 'churn') {
    await writeFile(path, (await readFile(path, 'utf8')) + `// round ${round}\n`)
  }

  if (behavior === 'outOfScope') {
    await writeFile(join(workspace, 'src/two.js'), `export const base = ${round + 2}\n`)
  }

  const result = behavior === 'blocked' ? { ...completed, verdict: 'blocked' as const } : completed
  return {
    role: 'implementer' as const,
    model: 'simulation',
    turns: 1,
    commands: [],
    snapshot: snapshotHash(await inventory(workspace)),
    result,
  }
}

test(
  'seeded repair scenarios terminate and commit only assigned work',
  { concurrency: 4 },
  async (t) => {
    await Promise.all(
      seeds.map((seed) =>
        t.test(`seed ${seed}`, async (st) => {
          const run = await scenario(st, seed)
          st.diagnostic(
            `ignore=${run.ignore} tracked-ignored=${run.trackedIgnored} policy=${run.policy} ` +
              `plan=${run.plan.join(',')}`,
          )
          let calls = 0
          const dispatch: Dispatcher = async (w) => {
            calls++
            assert.ok(calls <= repairRoundsWithoutGuidance + 1, `seed ${seed}: unbounded repair`)
            return act(w.workspace, run.plan[calls - 1]!, calls)
          }
          const state = await runLocalCandidate(
            run.setup.store,
            run.request,
            new AbortController().signal,
            dispatch,
          )
          const scenarioName = `seed ${seed} policy=${run.policy} plan=${run.plan.join(',')}`
          const context = `${scenarioName}: ${state.error}`
          st.diagnostic(
            `outcome=${state.status} rounds=${calls} ${state.error ?? ''}`.slice(0, 200),
          )
          assert.ok(['complete', 'needs_attention'].includes(state.status), context)

          // The copy's Git view is harness behavior, never the task's: it must always be clean.
          assert.doesNotMatch(state.error ?? '', /git-view/, context)
          assert.notEqual(
            state.receipts?.find((receipt) => receipt.check === 'git-view')?.status,
            'failed',
            context,
          )

          if (state.status === 'complete') {
            assert.notEqual(run.policy, 'inherited', context)
            const changed = await run.git(['diff', '--name-only', run.base, state.commit!])
            assert.deepEqual(changed.split('\n').filter(Boolean), ['src/one.js'], context)
            assert.equal(
              await run.git(['ls-tree', state.commit!, '--', 'node_modules']),
              '',
              context,
            )
            const snapshots = new Set(state.receipts?.map((receipt) => receipt.snapshot))
            assert.equal(snapshots.size, 1, context)
            return
          }

          assert.ok(
            stopReasons.some((reason) => reason.test(state.error ?? '')),
            `unexpected stop: ${context}`,
          )

          if (run.plan[0] === 'fix' && run.policy === 'plain') {
            assert.fail(`a first-round fix on a plain policy must complete: ${context}`)
          }
        }),
      ),
    )
  },
)
