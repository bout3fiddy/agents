import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import harness from '../src/extension.ts'
import { harnessRoot } from '../src/project.ts'
import { StateStore, atomicJson } from '../src/state.ts'
import { Delegations, activeTask } from '../src/delegation-state.ts'
import { gitCommand, resolveRemote } from '../src/git-branches.ts'
import { loadRole } from '../src/roles.ts'
import { branchFixture, verifyBranchFixtureFiles } from '../tests/branch-fixture.ts'

const githubIndex = process.argv.indexOf('--github')
const github = githubIndex < 0 ? undefined : process.argv[githubIndex + 1]

if (githubIndex >= 0 && !github) {
  throw new Error('--github requires an existing empty OWNER/REPO fixture repository')
}

const fixture = await branchFixture(github)
const { root } = fixture

// Exercise checkout preservation while the host can independently synchronize idle main.
await gitCommand(root, ['switch', '-c', 'fixture-working'])
const store = new StateStore(root)
const jobs = new Delegations(store)
const reports = join(harnessRoot, 'reports', `branches-${Date.now()}`)
await mkdir(reports, { recursive: true })
const agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent')
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(agentDir, 'models-store.json'),
})
const settings = SettingsManager.inMemory({ compaction: { enabled: false } })
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [harness],
})
await loader.reload()
const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  modelRuntime: runtime,
  model: runtime.getModel('openai-codex', 'gpt-6.1-sol')!,
  thinkingLevel: 'medium',
  tools: (await loadRole('orchestrator')).tools,
  resourceLoader: loader,
  settingsManager: settings,
  sessionManager: SessionManager.create(root, join(reports, 'sessions')),
})
await session.bindExtensions({
  onError(error) {
    throw new Error(JSON.stringify(error))
  },
})
const events: unknown[] = []
let foregroundWrites = 0
let modelSteps = 0
const notifications = () =>
  session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-task-result')
session.subscribe((event) => {
  events.push({ at: Date.now(), event })

  if (event.type === 'tool_execution_start' && ['write', 'edit'].includes(event.toolName)) {
    foregroundWrites++
  }

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    modelSteps++
  }
})
console.log(JSON.stringify({ root, reports, remote: fixture.remote, state: store.directory }))
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  void session.abort()
}, 40 * 60_000)

try {
  const started = performance.now()
  await session.prompt(
    'Implement the settled DESIGN.md using two independent background orchestrators in ' +
      'separate Git worktrees and branches. One owns src/clamp.mjs and test/clamp.test.mjs; ' +
      'the other owns src/unique.mjs and test/unique.test.mjs. Give each the document decisions, ' +
      'invariants and behavioral acceptance criteria. Each should use Astra implementation and ' +
      'run the required tests and push its branch. Do not merge yet; ' +
      'I will ask for merging later. No database or performance work is needed. ' +
      'You have authorization to publish this fixture. They should resolve review ' +
      'feedback autonomously. Return to our discussion while both work; ask me one conceptual ' +
      'question about why merge-time validation matters. Do not edit files yourself.',
  )
  const dispatchMs = performance.now() - started
  let batch = await jobs.list()
  assert.equal(batch.length, 2, 'Dispatch both independent tasks before returning to discussion')
  assert.ok(batch.every((job) => job.request.kind === 'branch'))
  assert.ok(batch.every((job) => activeTask(job.state)))
  assert.equal(foregroundWrites, 0)
  console.log(
    JSON.stringify({
      phase: 'discussion-returned',
      dispatchMs,
      tasks: batch.map((job) => job.request.id),
    }),
  )
  await session.reload()
  const next = performance.now()
  await session.prompt(
    'Answer the merge-validation question in two sentences, then ask one follow-up. ' +
      'Leave the independent orchestrators working and do not create another task or review.',
  )
  const discussionMs = performance.now() - next
  assert.ok(
    (await jobs.list()).some((job) => activeTask(job.state)),
    'The foreground discussion must continue while a branch task is active',
  )

  async function waitForTasks() {
    let last = ''

    for (;;) {
      if (timedOut) {
        break
      }

      batch = await jobs.list()
      const summary = batch.map((job) => ({
        id: job.request.id,
        state: job.state.status,
        error: job.state.error,
      }))
      const serialized = JSON.stringify(summary)

      if (serialized !== last) {
        console.log(serialized)
        last = serialized
      }

      if (batch.every((job) => !activeTask(job.state))) {
        break
      }

      await delay(1000)
    }
  }

  async function waitForNotices(version: number) {
    const expected = batch.map((job) => job.request.id + (version ? `:${version}` : ''))

    for (let attempt = 0; attempt < 120; attempt++) {
      const seen = session.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'custom_message' && entry.customType === 'pi-task-result'
            ? ((entry.details as { taskIds?: string[] }).taskIds ?? [])
            : [],
        )

      if (expected.every((id) => seen.includes(id))) {
        await session.waitForIdle()
        return
      }

      await delay(1000)
    }

    throw new Error('Both tasks must deliver their phase completion notifications')
  }

  await waitForTasks()
  assert.ok(
    batch.every((job) => job.state.status === 'published'),
    JSON.stringify(batch.map((job) => job.state.error)),
  )
  assert.equal(
    (await resolveRemote(root)).base,
    fixture.pinned.base,
    'Publication alone must not advance main',
  )
  await waitForNotices(0)
  const published = batch.map((job) => job.state)
  const mergeStarted = performance.now()
  await session.prompt(
    'Merge both published task branches to main now. Handle any automated GitHub review feedback ' +
      'autonomously: triage it, fix valid findings, push and await another review for up to five ' +
      'rounds, then merge with passing ordinary CI. If no review agents are triggered, continue. ' +
      'Use the original worktrees and serial merge queue with fresh checks against main. ' +
      'Return to discussion immediately and ask one question about concurrency.',
  )
  const mergeDispatchMs = performance.now() - mergeStarted
  await waitForTasks()

  assert.equal(timedOut, false, 'Live branch workflow exceeded the validation deadline')

  for (const job of batch) {
    assert.equal(job.state.status, 'complete', job.state.error)
    assert.ok(
      job.state.children?.some(
        (child) =>
          child.role === 'implementer' &&
          child.model === 'openai-codex/gpt-6.2-astra' &&
          child.verdict === 'pass',
      ),
    )
    const lint = job.state.receipts?.find((receipt) => receipt.check === 'harness-lint')
    assert.equal(lint?.status, 'passed')
    assert.match(lint.result.output, /upstream\.md: 1 inherited line-width finding/)
    assert.ok(
      job.state.receipts?.some(
        (receipt) => receipt.check === 'behavior' && receipt.status === 'passed',
      ),
    )
  }

  await waitForNotices(1)
  const acknowledgements = notifications().length
  assert.ok(acknowledgements >= 2 && acknowledgements <= 4)
  assert.equal(foregroundWrites, 0)
  assert.equal((await jobs.list()).length, 2)
  const main = (await resolveRemote(root)).base
  const branchStates = batch.map(
    (job) =>
      job.state as typeof job.state & {
        branch: string
        commit: string
        mergeBase: string
        mergeAttempts: number
        pullRequest?: string
      },
  )

  assert.equal(new Set(branchStates.map((state) => state.branch)).size, 2)
  assert.equal(new Set(branchStates.map((state) => state.mergeBase)).size, 2)
  assert.ok(branchStates.some((state) => state.mergeBase === fixture.pinned.base))

  for (const state of branchStates) {
    assert.ok(state.commit)
    await gitCommand(root, ['merge-base', '--is-ancestor', state.commit, main])
    const remote = await gitCommand(root, ['ls-remote', 'origin', `refs/heads/${state.branch}`])
    assert.equal(remote.split('\t')[0], state.commit)

    if (github) {
      assert.ok(state.pullRequest, 'GitHub branch tasks must create and retain PR evidence')
    }
  }

  await verifyBranchFixtureFiles(root, fixture.pinned.base, main)
  assert.equal(await gitCommand(root, ['rev-parse', 'HEAD']), fixture.pinned.base)
  const completedSteps = modelSteps
  const completedAcknowledgements = notifications().length
  await session.reload()
  await delay(1500)
  assert.equal(modelSteps, completedSteps, 'Reload must not repeat task completion responses')
  assert.equal(notifications().length, completedAcknowledgements)
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    github,
    base: fixture.pinned.base,
    main,
    dispatchMs,
    discussionMs,
    mergeDispatchMs,
    published,
    elapsedMs: performance.now() - started,
    foregroundWrites,
    modelSteps,
    acknowledgements,
    tasks: batch.map((job) => job.state),
  })
  console.log(JSON.stringify({ status: 'passed', reports, dispatchMs, discussionMs }))
} catch (error) {
  await atomicJson(join(reports, 'result.json'), {
    status: 'failed',
    root,
    github,
    error: String(error),
    tasks: (await jobs.list()).map((job) => job.state),
  })
  throw error
} finally {
  clearTimeout(timer)

  for (const job of await jobs.list()) {
    if (activeTask(job.state)) {
      await jobs.control(job.request.id, 'cancel')
    }
  }

  await writeFile(
    join(reports, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  await session.abort()
  session.dispose()
  await runtime.settleCredentialWrites()
}
