import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { captureSession } from '../tests/session-support.ts'
import { registerLocalTools } from '../src/local-tools.ts'
import { registerBranchTools } from '../src/branch-tools.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { activeTask, Delegations } from '../src/delegation-state.ts'
import { gitCommand } from '../src/git-branches.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { harnessRoot } from '../src/project.ts'

const coordinated = process.argv.includes('--coordinated')
const directory = await mkdtemp(join(tmpdir(), 'pi-live-local-'))
const root = join(directory, 'project')
await mkdir(root)
const git = (args: string[]) => gitCommand(root, args)
await git(['init', '-b', 'main'])
await git(['config', 'user.name', 'Pi local fixture'])
await git(['config', 'user.email', 'pi@example.invalid'])
const names = ['double', 'triple', 'quadruple']
const tasks = names.map((name, index) => ({
  title: name,
  task:
    'Implement ' +
    name +
    '(value) as multiplication by ' +
    (index + 2) +
    '. Edit only ' +
    name +
    '.mjs. The pinned gate is node gate.mjs ' +
    name +
    '.',
  writePaths: [name + '.mjs'],
}))

for (const name of names) {
  await writeFile(join(root, name + '.mjs'), 'export const ' + name + ' = () => null\n')
}

await writeFile(
  join(root, 'gate.mjs'),
  [
    "import assert from 'node:assert/strict'",
    '',
    "const names = ['double', 'triple', 'quadruple']",
    '',
    'for (const name of names) {',
    "  const fn = (await import('./' + name + '.mjs'))[name]",
    '',
    '  if (fn(1) === null && name !== process.argv[2]) {',
    '    continue',
    '  }',
    '',
    '  for (const n of [-17, 0, 4, 1.5]) {',
    '    assert.equal(fn(n), n * (names.indexOf(name) + 2))',
    '  }',
    '}',
    '',
  ].join('\n'),
)
await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node gate.mjs"}}\n')
await writeFile(
  join(root, 'DESIGN.md'),
  '# Arithmetic\n\n' + tasks.map((task) => task.task.replaceAll('. ', '.\n')).join('\n\n') + '\n',
)
execFileSync(process.execPath, [join(harnessRoot, 'scripts/linting/check.mjs'), root])
await git(['add', '.'])
await git(['commit', '-m', 'Pin workload'])

if (coordinated) {
  const remote = join(directory, 'remote.git')
  await gitCommand(directory, ['init', '--bare', remote])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', 'origin', 'HEAD:main'])
} else {
  await git(['switch', '-c', 'cleanup'])
}

const store = new StateStore(root)
const jobs = new Delegations(store)
const common = {
  objective: 'Implement three independent arithmetic operations.',
  mode: 'independent',
}
const local = {
  ...common,
  tasks: tasks.map((task, index) => ({
    ...task,
    acceptance: { argv: ['node', 'gate.mjs', names[index]!], workloadPaths: ['gate.mjs'] },
  })),
}
const published = {
  designPath: 'DESIGN.md',
  tasks: tasks.map((task) => ({
    ...task,
    invariants: ['Only the assigned module changes.'],
    acceptance: [task.task],
    database: false,
    performance: false,
  })),
}
let call:
  { name: string; arguments: typeof published | typeof local | { id: string } } | undefined = {
  name: coordinated ? 'delegate_branches' : 'delegate_local',
  arguments: coordinated ? published : local,
}
const { session, runtime } = await captureSession(
  root,
  join(directory, 'sdk'),
  [
    (pi) => {
      registerLocalTools(pi)
      registerBranchTools(pi)
      registerDelegation(pi)
    },
  ],
  async () => {
    if (call) {
      const next = call
      call = undefined
      return [{ type: 'toolCall', id: randomUUID(), ...next }]
    }

    return [{ type: 'text', text: 'Discussion continues.' }]
  },
)
const report = join(
  harnessRoot,
  'reports',
  'local-' + (coordinated ? 'baseline-' : 'direct-') + Date.now() + '.json',
)
const started = Date.now()
console.log(JSON.stringify({ root, started, report }))

try {
  await session.prompt('Build these three changes in parallel.')
  const returnedMs = Date.now() - started
  await session.prompt('Discuss a fourth operation while the first three run.')
  let batch = await jobs.list()
  assert.equal(batch.length, 3, JSON.stringify(session.messages.at(-2)))
  assert.ok(batch.some((job) => activeTask(job.state)))
  const firstEdit = new Map<string, number>()
  const deadline = started + 12 * 60_000

  while (batch.some((job) => activeTask(job.state))) {
    assert.ok(Date.now() < deadline, 'Live fixture exceeded its deadline')

    for (const job of batch) {
      if (job.state.candidate && !firstEdit.has(job.request.id)) {
        const code = await readFile(join(job.state.candidate, job.request.writePaths[0]!), 'utf8')

        if (!code.includes('=> null')) {
          firstEdit.set(job.request.id, Date.now() - started)
        }
      }
    }

    await delay(400)
    batch = await jobs.list()
  }

  const verifiedMs = Date.now() - started
  assert.ok(
    batch.every((job) => job.state.status === (coordinated ? 'published' : 'complete')),
    JSON.stringify(batch.map((job) => job.state.error)),
  )

  for (const job of batch) {
    assert.equal(job.state.changedPaths?.includes(job.request.writePaths[0]!), true)

    if (!coordinated) {
      call = { name: 'integrate_candidate', arguments: { id: job.request.id } }
      await session.prompt('Integrate this verified local change.')
    }
  }

  if (!coordinated) {
    for (const name of names) {
      const result = await import(join(root, name + '.mjs'))
      assert.equal(result[name](5), 5 * (names.indexOf(name) + 2))
    }
  }

  const verifiedAt = await Promise.all(
    batch.map(async (job) => {
      const marker = coordinated ? 'validated.json' : 'local-commit.json'
      return (await stat(join(store.directory, 'delegations', job.request.id, marker))).mtimeMs
    }),
  )
  assert.equal(firstEdit.size, batch.length)
  const result = {
    lastVerifiedMs: Math.max(...verifiedAt) - started,
    status: 'passed',
    root,
    coordinated,
    returnedMs,
    firstObservedEditMs: Math.min(...firstEdit.values()),
    verifiedOrPublishedMs: verifiedMs,
    totalMs: Date.now() - started,
    tasks: batch.map((job) => ({
      id: job.request.id,
      commit: job.state.commit,
      children: job.state.children?.map((c) => c.role),
    })),
  }
  await atomicJson(report, result)
  console.log(JSON.stringify(result))
} catch (error) {
  await atomicJson(report, {
    status: 'failed',
    error: String(error),
    root,
    states: (await jobs.list()).map((j) => j.state),
  })
  throw error
} finally {
  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  await session.abort()
  session.dispose()
  await runtime.settleCredentialWrites()
}
