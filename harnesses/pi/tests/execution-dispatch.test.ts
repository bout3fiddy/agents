// The host-only `isolation: 'required'` requirement, from the dispatch tool that accepts it to the
// worker request, check and benchmark that obey it. worker-execution.test.ts covers the decision
// itself with Node built-ins only; this file drives the real tools, runners and coordinator.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import { fanoutSchema } from '../src/branch-contracts.ts'
import { runBranchTask } from '../src/branch-runner.ts'
import { registerBranchTools } from '../src/branch-tools.ts'
import type { Project, ProjectCheck, WorkerResult } from '../src/contracts.ts'
import { runDelegation } from '../src/delegation-runner.ts'
import {
  Delegations,
  delegateSchema,
  delegationDirectory,
  delegationView,
  type DelegationRequest,
} from '../src/delegation-state.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import type { Dispatcher } from '../src/dispatch.ts'
import { registerWorkflow } from '../src/extension.ts'
import { runLocalCandidate } from '../src/local-candidate.ts'
import { localBatchSchema } from '../src/local-contracts.ts'
import { registerLocalTools } from '../src/local-tools.ts'
import { benchmarkReceipts, loadProject } from '../src/project.ts'
import { RecurringTasks, scheduleSchema } from '../src/recurring.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson, readJson, StateStore } from '../src/state.ts'
import { createTaskCoordinatorTools, type TaskCoordinatorRequest } from '../src/task-coordinator.ts'
import { reviseTasks } from '../src/task-recovery.ts'
import {
  isolationUnavailable,
  recordTrustDecision,
  taskExecution,
  type ExecutionPolicy,
} from '../src/worker-execution.ts'
import { createWorkerTools } from '../src/worker-tools.ts'
import { benchmarks, runWorkflow } from '../src/workflow.ts'
import { branchRepository } from './branch-support.ts'
import { captureSession } from './session-support.ts'
import { design, evidence, fixture, hashes } from './support.ts'

const trusted: ExecutionPolicy = { mode: 'trusted-local', reason: 'enrolled' }
const required: ExecutionPolicy = { mode: 'required-isolation', reason: 'task-policy' }
const origin = { session: 'execution-session', model: 'test/model' }
const signal = () => new AbortController().signal
const captured = new Error('stop after capturing the worker request')

function setEnvironment(t: TestContext, name: string, value: string | undefined) {
  const previous = process.env[name]
  const assign = (next: string | undefined) => {
    if (next === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = next
    }
  }
  assign(value)
  t.after(() => assign(previous))
}

/** Enroll a project as trusted-local in a registry private to the test. Every route below must
 * then isolate a task on its own flag alone. */
async function enroll(t: TestContext, base: string, root: string) {
  setEnvironment(t, 'PI_HARNESS_AGENT_DIR', join(base, 'trust'))
  setEnvironment(t, 'PI_HARNESS_ISOLATION', undefined)
  assert.deepEqual(await recordTrustDecision(root, 'trusted-local'), trusted)
}

function invoke(tools: ToolDefinition[], name: string, args: unknown) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `tool ${name} is available`)
  return tool.execute('fixture', args, undefined, undefined, {} as never)
}

function parsed(result: Awaited<ReturnType<typeof invoke>>) {
  const [content] = result.content
  assert.ok(content?.type === 'text')
  return {
    ...JSON.parse(content.text),
    isError: (result as { isError?: boolean }).isError === true,
  }
}

type Call = { name: string; arguments: Record<string, unknown> }

/** Call the registered host tools through a real Pi session, one call per model turn. Returns the
 * requests handed to the launcher and each tool result by call index. */
async function dispatchThroughTools(t: TestContext, calls: (isolation: unknown) => Call[]) {
  const setup = await branchRepository(t)
  const launched: DelegationRequest[] = []
  const launch = async (request: DelegationRequest) => {
    launched.push(request)
  }
  const run = async (isolation: unknown) => {
    const planned = calls(isolation)
    let turn = 0
    const { session, runtime } = await captureSession(
      setup.root,
      join(setup.directory, `agent-${String(isolation)}`),
      [
        (pi) => {
          registerWorkflow(pi, registerDelegation(pi, launch).start)
          registerLocalTools(pi, launch)
          registerBranchTools(pi, launch)
        },
      ],
      async () => {
        const call = planned[turn++]
        return call
          ? [
              {
                type: 'toolCall',
                id: `call-${turn - 1}`,
                name: call.name,
                arguments: call.arguments as never,
              },
            ]
          : [{ type: 'text', text: 'Dispatched.' }]
      },
    )

    try {
      await session.prompt('Dispatch the planned work.')
      return planned.map((_call, index) => {
        const result = session.state.messages.find(
          (message) => message.role === 'toolResult' && message.toolCallId === `call-${index}`,
        )
        assert.ok(result?.role === 'toolResult', `call ${index} has a result`)
        return { isError: result.isError, text: JSON.stringify(result.content) }
      })
    } finally {
      session.dispose()
      await runtime.settleCredentialWrites()
    }
  }
  return { setup, launched, run }
}

const withIsolation = (isolation: unknown) => (isolation === undefined ? {} : { isolation })

/** One call to each tool that starts workers, on disjoint scopes of the branch fixture. */
const everyRoute = (isolation: unknown): Call[] => [
  { name: 'workflow', arguments: { design, ...withIsolation(isolation) } },
  {
    name: 'delegate_task',
    arguments: {
      kind: 'research',
      task: 'Survey the arithmetic module',
      context: 'Read-only.',
      writePaths: [],
      ...withIsolation(isolation),
    },
  },
  {
    name: 'delegate_local',
    arguments: {
      objective: 'Add doubled to the first module.',
      acceptance: { argv: ['node', '--test'] },
      tasks: [{ task: 'Add doubled', writePaths: ['src/one.js'] }],
      ...withIsolation(isolation),
    },
  },
  {
    name: 'delegate_branches',
    arguments: {
      designPath: 'docs/design.md',
      tasks: [
        {
          task: 'Implement tripled in two',
          writePaths: ['src/two.js', 'tests/two.test.js'],
          invariants: ['Preserve existing exports.'],
          acceptance: ['Arithmetic properties pass.'],
          database: false,
          performance: false,
        },
      ],
      ...withIsolation(isolation),
    },
  },
]

const routeOf = (request: DelegationRequest) =>
  request.local ? 'local' : request.branch ? 'branch' : request.kind

/** Run each stored request through its real runner and capture the execution decision its first
 * worker or coordinator request carries. Every fake stops right after the capture. */
async function workerExecutions(store: StateStore, launched: DelegationRequest[]) {
  const seen: Record<string, ExecutionPolicy | undefined> = {}

  for (const request of launched) {
    const route = routeOf(request)
    const dispatch: Dispatcher = async (worker) => {
      seen[route] = worker.project.execution
      throw captured
    }
    const coordinate = async (assignment: TaskCoordinatorRequest): Promise<never> => {
      seen[route] = assignment.project.execution
      throw captured
    }

    if (request.local) {
      await runLocalCandidate(store, request, signal(), dispatch)
    } else if (request.kind === 'branch') {
      await runBranchTask(store, request, signal(), coordinate)
    } else {
      await runDelegation(store, request.id, signal(), coordinate, () => dispatch)
    }
  }

  return seen
}

test('isolation set on a dispatch tool reaches the workers of every route', async (t) => {
  const { setup, launched, run } = await dispatchThroughTools(t, everyRoute)
  const results = await run('required')
  assert.deepEqual(
    results.map((result) => result.isError),
    [false, false, false, false],
    JSON.stringify(results),
  )
  assert.deepEqual(launched.map(routeOf), ['implementation', 'research', 'local', 'branch'])

  for (const request of launched) {
    const directory = delegationDirectory(setup.store, request.id)
    const stored = await readJson<DelegationRequest>(join(directory, 'request.json'))
    assert.equal(stored?.isolation, 'required', routeOf(request))
    assert.equal(delegationView(await setup.jobs.get(request.id)).isolation, 'required')
  }

  assert.equal((await setup.store.checkpoint())?.isolation, 'required')

  // The user enrolled this project. Only the task's own flag isolates its workers.
  await enroll(t, setup.directory, setup.root)
  assert.deepEqual((await loadProject(setup.root)).execution, trusted)
  assert.deepEqual(await workerExecutions(setup.store, launched), {
    implementation: required,
    research: required,
    local: required,
    branch: required,
  })
})

test('negative control: the same routes without the flag run trusted-local', async (t) => {
  const { setup, launched, run } = await dispatchThroughTools(t, everyRoute)
  const results = await run(undefined)
  assert.ok(
    results.every((result) => !result.isError),
    JSON.stringify(results),
  )
  assert.ok(launched.every((request) => !Object.hasOwn(request, 'isolation')))
  assert.equal((await setup.store.checkpoint())?.isolation, undefined)
  await enroll(t, setup.directory, setup.root)
  assert.deepEqual(await workerExecutions(setup.store, launched), {
    implementation: trusted,
    research: trusted,
    local: trusted,
    branch: trusted,
  })
})

test('no dispatch tool accepts a value that would lift or weaken isolation', async (t) => {
  for (const value of ['none', 'trusted-local', 'optional', false, true, '']) {
    const { launched, run } = await dispatchThroughTools(t, everyRoute)
    const results = await run(value)
    assert.deepEqual(
      results.map((result) => result.isError),
      [true, true, true, true],
      JSON.stringify({ value, results }),
    )
    assert.equal(launched.length, 0, `nothing starts for isolation=${String(value)}`)
  }

  // The SDK drops a null optional argument, so it is the omitted field and stores nothing.
  const omitted = await dispatchThroughTools(t, everyRoute)
  await omitted.run(null)
  assert.equal(omitted.launched.length, 4)
  assert.ok(omitted.launched.every((request) => request.isolation === undefined))

  // The stored forms and the schedule definition accept the same single value.
  const task = { kind: 'research', task: 'Survey', context: '', writePaths: [] }
  const audit = { kind: 'audit', task: 'Audit progress' }
  const schemas = [
    [delegateSchema, task],
    [localBatchSchema, everyRoute(undefined)[2]!.arguments],
    [fanoutSchema, everyRoute(undefined)[3]!.arguments],
    [scheduleSchema, { everyMinutes: 1, work: task }],
    [scheduleSchema, { everyMinutes: 1, work: audit }],
  ] as const

  for (const [schema, base] of schemas) {
    const work = (base as { work?: object }).work
    const at = (isolation: unknown) =>
      work ? { ...base, work: { ...work, isolation } } : { ...base, isolation }
    assert.equal(Check(schema, base), true)
    assert.equal(Check(schema, at('required')), true)

    for (const value of ['none', 'trusted-local', false, null]) {
      assert.equal(Check(schema, at(value)), false, JSON.stringify(at(value)))
    }
  }
})

test('resume, revision and a resumed scope keep the isolation they were given', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const store = new StateStore(root)
  const jobs = new Delegations(store)
  const launched: DelegationRequest[] = []
  const launch = async (request: DelegationRequest) => {
    launched.push(request)
  }
  const pause = async (id: string, status: 'paused' | 'needs_attention') => {
    const path = join(delegationDirectory(store, id), 'status.json')
    await atomicJson(path, { ...(await jobs.get(id)).state, status })
  }

  const research = await jobs.start(
    { kind: 'research', task: 'Survey', context: '', writePaths: [], isolation: 'required' },
    origin,
    launch,
  )
  await pause(research.request.id, 'paused')
  await reviseTasks(jobs, {
    tasks: [{ id: research.request.id, task: 'Survey again', context: 'Revised.' }],
  })
  assert.equal((await jobs.get(research.request.id)).request.isolation, 'required')
  await jobs.resume(research.request.id, origin, launch)
  assert.equal(launched.at(-1)?.task, 'Survey again')
  assert.equal(launched.at(-1)?.isolation, 'required')
  await pause(research.request.id, 'needs_attention')

  // workflow without a design resumes the recorded scope, isolation included.
  const implementation = { kind: 'implementation', task: 'Implement', context: '', writePaths: [] }
  const first = await jobs.start(
    { ...implementation, kind: 'implementation', design, isolation: 'required' },
    origin,
    launch,
  )
  await pause(first.request.id, 'needs_attention')
  const resumed = await jobs.start({ ...implementation, kind: 'implementation' }, origin, launch)
  assert.equal(resumed.request.isolation, 'required')
  assert.equal(resumed.request.checkpointHash, first.request.checkpointHash)

  // The recorded scope isolates a direct workflow run that carries no task flag at all.
  await enroll(t, base, root)
  const seen: (ExecutionPolicy | undefined)[] = []
  const capture: Dispatcher = async (request) => {
    seen.push(request.project.execution)
    throw captured
  }
  await runWorkflow(store, 'fixture/model', undefined, capture)
  assert.deepEqual(seen, [required])

  // Negative control: pinning the same design without the requirement runs trusted-local.
  const release = await store.lock()
  await store.pin(design).finally(release)
  await runWorkflow(store, 'fixture/model', undefined, capture)
  await runWorkflow(store, 'fixture/model', undefined, capture, {}, undefined, 'required')
  assert.deepEqual(seen, [required, trusted, required])
})

test('a stored isolation value the host never wrote stops the task', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const store = new StateStore(root)
  const jobs = new Delegations(store)
  await enroll(t, base, root)
  let dispatched = 0
  const never = async (): Promise<never> => {
    dispatched++
    throw captured
  }

  for (const kind of ['research', 'implementation'] as const) {
    const job = await jobs.start(
      {
        kind,
        task: 'Survey',
        context: '',
        writePaths: [],
        ...(kind === 'implementation' && { design }),
      },
      origin,
      async () => {},
    )
    const path = join(delegationDirectory(store, job.request.id), 'request.json')
    await atomicJson(path, { ...job.request, isolation: 'none' })
    const state = await runDelegation(store, job.request.id, signal(), never, () => never)
    assert.equal(state.status, 'needs_attention', kind)
    assert.match(state.error ?? '', /Task isolation accepts only "required"/, kind)
  }

  assert.equal(dispatched, 0)
})

test('scheduled work and audits carry their isolation into every occurrence', async (t) => {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const started: DelegationRequest[] = []
  const schedules = new RecurringTasks(new StateStore(root), join(base, 'private'), async (job) => {
    started.push(job)
  })
  const now = Date.now()
  const minute = 60_000
  const work = {
    kind: 'documents' as const,
    task: 'Update the log',
    context: '',
    writePaths: ['log.md'],
  }
  await schedules.set(
    'log',
    { everyMinutes: 1, work: { ...work, isolation: 'required' } },
    origin.session,
    false,
    now,
  )
  await schedules.set(
    'audit',
    { everyMinutes: 1, work: { kind: 'audit', task: 'Audit progress', isolation: 'required' } },
    origin.session,
    true,
    now,
  )
  await schedules.tick(origin, () => [], now + minute)
  assert.deepEqual(started.map((job) => job.kind).sort(), ['documents', 'research'])
  assert.deepEqual(
    started.map((job) => job.isolation),
    ['required', 'required'],
  )
  assert.ok(started.find((job) => job.kind === 'research')?.recurring?.audit)
  await assert.rejects(
    schedules.set(
      'bad',
      { everyMinutes: 1, work: { ...work, isolation: 'none' as never } },
      origin.session,
    ),
  )
})

async function coordinatorFixture(t: TestContext) {
  const { base, root, store } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  await enroll(t, base, root)
  const project = await loadProject(root)
  assert.deepEqual(project.execution, trusted)
  const checkpoint = (await store.checkpoint())!
  const request = async (execution: ExecutionPolicy): Promise<TaskCoordinatorRequest> => ({
    task: 'Coordinate scoped work',
    context: 'Preserve unrelated work',
    kind: 'documents',
    workspace: root,
    project: { ...project, execution },
    checkpoint,
    model: 'openai-codex/gpt-6.1-sol',
    outputPath: join(base, 'coordinator', 'result.json'),
    baseline: await hashes(root),
    originals: root,
  })
  return { base, root, request }
}

const swarm = (ids: string[]) => ({
  role: 'task-worker',
  task: 'Survey the fixture independently',
  writePaths: [],
  researchers: ids.map((id) => ({ id, task: `Investigate ${id}` })),
})
const leaf = { role: 'task-worker', task: 'Update the scoped file', writePaths: ['src/**'] }
const researcherOf = (child: Parameters<Dispatcher>[0]): string | undefined =>
  JSON.parse(child.task).research?.researcher

async function receipt(child: Parameters<Dispatcher>[0], result: Partial<WorkerResult> = {}) {
  return { ...(await evidence(child, result)), model: (await loadRole(child.role)).model }
}

/** The real worker tools a child process builds from the request its coordinator dispatched. */
async function workerTools(child: Parameters<Dispatcher>[0], base: string, label: string) {
  const request = { ...child, outputPath: join(base, `attempt-${label}`) }
  return createWorkerTools(request, await loadRole(child.role)).tools
}

test('children and swarm researchers inherit their coordinator isolation', async (t) => {
  const item = await coordinatorFixture(t)
  const canary = join(item.base, 'child-canary')
  const argv = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(canary)}, 'escaped')`]
  const seen: Record<string, unknown> = {}
  const runs: Record<string, ReturnType<typeof parsed>> = {}
  const dispatch: Dispatcher = async (child) => {
    const label = researcherOf(child) ?? 'writer'
    seen[label] = child.project.execution
    seen[`${label}:shell`] = JSON.parse(child.task).capabilities.shell
    const tools = await workerTools(child, item.base, label)
    runs[label] = parsed(await invoke(tools, 'run_command', { argv }))
    return receipt(child)
  }
  const isolated = await createTaskCoordinatorTools(
    await item.request(taskExecution(trusted, { isolation: 'required' })),
    signal(),
    dispatch,
  )
  await invoke(isolated.tools, 'delegate_worker', swarm(['a', 'b']))
  await invoke(isolated.tools, 'delegate_worker', leaf)

  for (const label of ['a', 'b', 'writer']) {
    assert.deepEqual(seen[label], required, label)
    assert.match(String(seen[`${label}:shell`]), /No network, host-home access/, label)
    assert.equal(runs[label]?.execution, 'required-isolation', label)
    assert.equal(runs[label]?.runner, 'sandbox', label)
    assert.notEqual(runs[label]?.exitCode, 0, label)
  }

  await assert.rejects(readFile(canary), /ENOENT/)

  // Negative control: under the enrollment alone the same child command runs on the host.
  const local = await createTaskCoordinatorTools(await item.request(trusted), signal(), dispatch)
  await invoke(local.tools, 'delegate_worker', leaf)
  assert.deepEqual(seen.writer, trusted)
  assert.match(String(seen['writer:shell']), /Normal local commands in disposable project copies/)
  assert.equal(runs.writer?.runner, 'host')
  assert.equal(await readFile(canary, 'utf8'), 'escaped')
})

/** Read the file system until a path exists, without wall-clock waits. */
async function appears(path: string) {
  for (let trip = 0; trip < 200_000; trip++) {
    try {
      await stat(path)
      return
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    }
  }

  assert.fail(`${path} never appeared`)
}

test('trusted command restoration never undoes a legitimate edit', async (t) => {
  const item = await coordinatorFixture(t)
  const before = await hashes(item.root)
  const events: string[] = []
  const stray = join(item.root, 'stray.md')
  const legitimate = join(item.root, 'src', 'legitimate.js')

  // A trusted command that names the candidate: it leaves a stray file outside the assignment,
  // then keeps running until the worker's own scoped edit has landed beside it.
  const overlapping =
    `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(stray)}, 'stray'); ` +
    'const idle = new Int32Array(new SharedArrayBuffer(4)); const end = Date.now() + 20000; ' +
    `while (!fs.existsSync(${JSON.stringify(legitimate)})) { ` +
    'if (Date.now() > end) process.exit(3); Atomics.wait(idle, 0, 0, 5) }'
  const outcome: { writer?: ReturnType<typeof parsed> } = {}
  const dispatch: Dispatcher = async (child) => {
    const id = researcherOf(child)
    const tools = await workerTools(child, item.base, id ?? 'writer')
    events.push(`${id ?? 'writer'} starts`)

    if (id) {

      // A researcher shares the candidate with its siblings and can retain nothing in it.
      assert.deepEqual(child.checkpoint.writePaths, [])
      await assert.rejects(
        invoke(tools, 'project_write', { path: 'src/value.js', content: 'edited\n' }),
        /outside|scope|assign/i,
      )
      const read = parsed(await invoke(tools, 'run_command', { argv: ['cat', 'src/value.js'] }))
      assert.equal(read.runner, 'host')
      assert.equal(read.restoredCandidatePaths, undefined)
      events.push(`${id} ends`)
      return receipt(child)
    }

    const command = invoke(tools, 'run_command', { argv: ['node', '-e', overlapping] })
    await appears(stray)
    await invoke(tools, 'project_write', { path: 'src/legitimate.js', content: 'kept\n' })
    outcome.writer = parsed(await command)
    events.push('writer ends')
    return receipt(child)
  }
  const worker = await createTaskCoordinatorTools(await item.request(trusted), signal(), dispatch)

  // The writer is requested while the swarm runs and still starts only after it settled.
  const research = invoke(worker.tools, 'delegate_worker', swarm(['a', 'b']))
  const writing = invoke(worker.tools, 'delegate_worker', leaf)
  await research
  assert.deepEqual(await hashes(item.root), before, 'a read-only swarm leaves the candidate as is')
  await writing
  assert.deepEqual(events.slice(0, 2).sort(), ['a starts', 'b starts'])
  assert.deepEqual(events.slice(2, 4).sort(), ['a ends', 'b ends'])
  assert.deepEqual(events.slice(4), ['writer starts', 'writer ends'])

  // The stray write is undone and reported; the scoped edit made during the command survives.
  assert.equal(outcome.writer?.exitCode, 0, outcome.writer?.output)
  assert.equal(outcome.writer?.runner, 'host')
  assert.equal(outcome.writer?.isError, true)
  assert.deepEqual(outcome.writer?.restoredCandidatePaths, ['stray.md'])
  assert.equal(await readFile(legitimate, 'utf8'), 'kept\n')
  await assert.rejects(readFile(stray), /ENOENT/)
  assert.deepEqual(await hashes(item.root), { ...before, ...(await hashes(item.root)) })
  assert.deepEqual(
    Object.keys(await hashes(item.root)).filter((name) => !(name in before)),
    ['src/legitimate.js'],
  )

  // A swarm cannot be given a write scope, so no researcher ever holds an assigned path.
  await assert.rejects(
    invoke(worker.tools, 'delegate_worker', { ...swarm(['c', 'd']), writePaths: ['src/**'] }),
    /read-only/,
  )
})

const lockfile = (version: string) =>
  JSON.stringify({
    packages: {
      '': { dependencies: { 'pinned-sdk': version } },
      'node_modules/pinned-sdk': { version },
    },
  })
const benchmark = (
  id: string,
  argv: string[],
  extra: Partial<ProjectCheck> = {},
): ProjectCheck => ({
  id,
  argv,
  required: true,
  kind: 'benchmark',
  timeoutMs: 30_000,
  ...extra,
})

/** An enrolled project whose nested package pins an installed module, beside another version
 * one level up, as in verification-loop.test.ts. */
async function benchmarkProject(t: TestContext) {
  const { base, root } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  await enroll(t, base, root)
  const files = {
    'pkg/package-lock.json': lockfile('1.2.3'),
    'pkg/probe.cjs': "console.log(require('pinned-sdk/package.json').version)\n",
    'pkg/node_modules/pinned-sdk/package.json': '{"version":"1.2.3"}',
    'node_modules/pinned-sdk/package.json': '{"version":"9.9.9"}',
  }

  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }

  const canary = join(base, 'benchmark-canary')
  const escape = `require('fs').writeFileSync(${JSON.stringify(canary)}, 'escaped')`
  const loaded = await loadProject(root)
  const project = (execution: ExecutionPolicy | undefined, checks: ProjectCheck[]): Project => ({
    ...loaded,
    execution,
    checks,
  })
  return { base, root, canary, escape, project }
}

test('benchmark checks follow the execution decision and resolve nested pins', async (t) => {
  const item = await benchmarkProject(t)
  const nested = benchmark('nested', ['node', 'pkg/probe.cjs'])
  const before = await hashes(item.root)

  // An enrolled project measures as a local command and loads the version its package pins.
  const [local] = await benchmarks(item.root, item.project(trusted, [nested]))
  assert.equal(local?.status, 'passed', local?.result.output)
  assert.equal(local?.result.runner, 'host')
  assert.equal(local?.result.output.trim(), '1.2.3')
  assert.equal(benchmarks, benchmarkReceipts)

  // Every other decision measures in the sandbox. Where the sandbox cannot start the benchmark
  // fails; it is never repeated on the host.
  const policies: (ExecutionPolicy | undefined)[] = [
    undefined,
    { mode: 'isolated', reason: 'unknown-project' },
    taskExecution(trusted, { isolation: 'required' }),
    { mode: 'required-isolation', reason: 'project-policy' },
  ]

  for (const policy of policies) {
    const label = JSON.stringify(policy)
    const [sandboxed] = await benchmarks(item.root, item.project(policy, [nested]))
    assert.equal(sandboxed?.result.runner, 'sandbox', label)

    if (isolationUnavailable(sandboxed!.result)) {
      assert.equal(sandboxed?.status, 'failed', label)
    } else {
      assert.equal(sandboxed?.status, 'passed', sandboxed?.result.output)
      assert.equal(sandboxed?.result.output.trim(), '1.2.3', label)
    }

    // A benchmark that declares the host runner still never leaves the sandbox.
    const declared = benchmark('escape', ['node', '-e', item.escape], { runner: 'host' })
    const [escaped] = await benchmarks(item.root, item.project(policy, [declared]))
    assert.equal(escaped?.result.runner, 'sandbox', label)
    assert.equal(escaped?.status, 'failed', label)
    await assert.rejects(readFile(item.canary), /ENOENT/, label)
  }

  // Negative control: the same argv does reach the host once only the enrollment applies.
  const [reached] = await benchmarks(
    item.root,
    item.project(trusted, [benchmark('escape', ['node', '-e', item.escape])]),
  )
  assert.equal(reached?.status, 'passed', reached?.result.output)
  assert.equal(await readFile(item.canary, 'utf8'), 'escaped')
  assert.deepEqual(await hashes(item.root), before)
})

test('a benchmark never measures another version than its package pins', async (t) => {
  const item = await benchmarkProject(t)
  const nested = benchmark('nested', ['node', 'pkg/probe.cjs'])

  // An installed tree that drifted from the candidate lockfile stops the benchmark.
  await writeFile(join(item.root, 'pkg', 'package-lock.json'), lockfile('2.0.0'))
  await assert.rejects(
    benchmarks(item.root, item.project(trusted, [nested])),
    /pinned-sdk is 1\.2\.3; the lockfile pins 2\.0\.0.*npm ci/,
  )

  // A package that was never installed fails loudly instead of measuring the version above it.
  await writeFile(join(item.root, 'pkg', 'package-lock.json'), lockfile('1.2.3'))
  await rm(join(item.root, 'pkg', 'node_modules'), { recursive: true })
  const [guarded] = await benchmarks(item.root, item.project(trusted, [nested]))
  assert.equal(guarded?.status, 'failed')
  assert.equal(guarded?.result.runner, 'host')
  assert.match(
    guarded!.result.output,
    /pinned-sdk@1\.2\.3 is pinned by pkg\/package-lock\.json.*node_modules holds 9\.9\.9/,
  )
  assert.doesNotMatch(guarded!.result.output, /^9\.9\.9$/m)

  // The guard lives in the benchmark's copy; the candidate gains no dependency directory.
  await assert.rejects(stat(join(item.root, 'pkg', 'node_modules')), /ENOENT/)
})
