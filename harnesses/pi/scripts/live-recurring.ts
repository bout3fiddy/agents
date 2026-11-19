import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { RecurringTasks } from '../src/recurring.ts'
import harness from '../src/extension.ts'
import { loadRole } from '../src/roles.ts'
import { harnessRoot } from '../src/project.ts'
import { StateStore } from '../src/state.ts'
import { Delegations } from '../src/delegation-state.ts'

const fable = process.argv.includes('--fable')
const marker = randomUUID()
const root = await mkdtemp(join(tmpdir(), 'pi-live-recurring-'))
const reports = join(harnessRoot, 'reports', `recurring-${Date.now()}`)
await mkdir(reports, { recursive: true })
const agentDir = join(homedir(), '.pi/agent')
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

const schedules = new RecurringTasks(new StateStore(root))
const jobs = new Delegations(schedules.store)
const timeout = Date.now() + 360000
const invoked: string[] = []
session.subscribe((event) => {
  if (event.type === 'tool_execution_start') {
    invoked.push(event.toolName)
  }
})
console.log(JSON.stringify({ root, reports }))

try {
  await writeFile(
    join(root, 'status.md'),
    '# Build\n\nThe fixture build completed. Final receipt ' + marker + '\n',
  )

  if (fable) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-e', "require('node:fs').writeFileSync('build.txt','completed fixture build')"],
      { cwd: root },
    )
    const sha256 = createHash('sha256')
      .update(await readFile(join(root, 'build.txt')))
      .digest('hex')
    await writeFile(
      join(root, 'receipt.json'),
      JSON.stringify({
        id: marker,
        result: 'passed',
        exitCode: 0,
        artifact: 'build.txt',
        sha256,
        stdout,
      }),
    )
  }

  if (!fable) {
    await session.prompt('The fixture build completed today. Acknowledge in a sentence.')
  }

  await session.prompt(
    'Set a recurring progress audit named build-audit, every hour, ' +
      'starting immediately. Read status.md and the new task observations, report any blocker. ' +
      (fable
        ? 'Fable Medium, Opus fallback. Save Markdown under .pi/audits/progress. ' +
          'Read status.md and receipt.json. Quote the receipt ID. Stop when receipt.json has ' +
          'that ID, result passed, exitCode 0, and the named artifact exists. ' +
          'Record why. Just confirm setup.'
        : 'Use Codex low, the default JSON report and no custom reportDirectory. Confirm setup.'),
  )
  assert.ok(invoked.includes('recurring_task'))
  assert.equal((await schedules.list())[0]?.name, 'build-audit')
  await session.reload()
  let job

  while (Date.now() < timeout) {
    job = (await jobs.list()).find((item) => item.request.recurring?.name === 'build-audit')

    if (job?.state.status === 'complete' || job?.state.status === 'needs_attention') {
      break
    }

    await delay(500)
  }

  assert.equal(job?.state.status, 'complete', job?.state.error)
  assert.ok(job.state.auditReport)
  const raw = await readFile(join(root, job.state.auditReport), 'utf8')

  if (fable) {
    assert.match(job.state.auditReport, /^\.pi\/audits\/progress\/.*\.md$/)
    assert.ok(raw.includes(marker))
    assert.equal(job.state.children?.[0]?.role, 'progress-auditor')
    assert.match(
      job.state.children[0]!.model,
      /^claude-cli\/(?:claude-fable-5-2|(?:claude-)?opus)(?:-|$)/,
    )
    assert.match(raw, /medium/)
    assert.equal(job.state.auditDecision?.action, 'stop', job.state.auditDecision?.reason)

    while ((await schedules.list())[0]?.status !== 'stopped' && Date.now() < timeout) {
      await delay(300)
    }

    assert.equal((await schedules.list())[0]?.status, 'stopped')
    assert.ok(job.state.auditDecision?.reason)
    assert.ok(raw.includes(job.state.auditDecision.reason))
    assert.ok(!invoked.includes('consult_design'))
  } else {
    const report = JSON.parse(raw)
    assert.equal(report.job, job.request.id)
    assert.match(JSON.stringify(report.result), /build/i)
  }

  await session.prompt('Stop and remove the build-audit schedule now.', {
    streamingBehavior: 'followUp',
  })

  while ((await schedules.list()).length && Date.now() < timeout) {
    await delay(300)
  }

  assert.deepEqual(await schedules.list(), [])
  assert.equal((await jobs.list()).filter((item) => item.request.recurring).length, 1)
  const result = {
    job: job.request.id,
    report: job.state.auditReport,
    status: job.state.status,
    removed: true,
    ...(fable && { children: job.state.children, decision: job.state.auditDecision }),
    invoked,
  }
  await writeFile(join(reports, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await schedules.remove('build-audit')
  await session.waitForIdle()
  session.dispose()
  await runtime.settleCredentialWrites()
}
