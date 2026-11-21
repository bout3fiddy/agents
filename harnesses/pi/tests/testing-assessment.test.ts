import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import { engineeringReviewSchema, testingScore } from '../src/testing-assessment.ts'
import { createWorkerTools } from '../src/worker-tools.ts'
import { loadRole } from '../src/roles.ts'
import { loadProject } from '../src/project.ts'
import { atomicJson } from '../src/state.ts'
import { delegationDirectory } from '../src/delegation-state.ts'
import { reviewReceipts } from '../src/inspection.ts'
import { fixture } from './support.ts'

const tested = { points: 2, evidence: 'editor.spec.ts saved a draft through the real service.' }
const absent = { points: 0, evidence: 'No test exercises the boundary.' }
const exempt = { inapplicable: 'Single-user form without ordering or recovery requirements.' }
const testing = {
  productionPath: tested,
  invariants: tested,
  exploration: tested,
  recovery: exempt,
  replay: exempt,
  browserJourney: tested,
}
const engineeringReview = {
  tigerStyle: 'editor.ts bounds the draft length before saving.',
  testing,
}
const result = {
  verdict: 'pass',
  summary: 'Reviewed.',
  findings: [],
  databaseImpact: false,
  evidence: [],
}

test('browser journeys contribute to the score and exemptions never earn points', () => {
  assert.equal(testingScore(engineeringReview), 100)
  const score = (browserJourney: typeof tested | typeof exempt) =>
    testingScore({ ...engineeringReview, testing: { ...testing, browserJourney } })
  assert.equal(score(absent), 75)
  assert.equal(score({ ...tested, points: 1 }), 88)
  assert.equal(score(exempt), 100)
  assert.equal(testingScore({ ...engineeringReview, testing: { unscored: 'Prose only.' } }), null)

  for (const fields of [
    { productionPath: exempt },
    { replay: { inapplicable: ' ' } },
    { browserJourney: { points: 3, evidence: 'claimed' } },
    { total: 100 },
  ]) {
    assert.equal(
      Check(engineeringReviewSchema, { ...engineeringReview, testing: { ...testing, ...fields } }),
      false,
    )
  }
})

test('review receipts bind testing evidence to the candidate snapshot', async (t) => {
  const { base, root, store } = await fixture()
  t.after(() => rm(base, { recursive: true, force: true }))
  const role = await loadRole('implementer')
  const request = {
    role: role.name as 'implementer',
    task: 'Review draft save.',
    workspace: root,
    project: await loadProject(root),
    checkpoint: (await store.checkpoint())!,
    model: role.model,
    outputPath: join(base, 'result.json'),
    baseline: {},
    changedFiles: ['src/editor.ts'],
  }
  const worker = createWorkerTools(request, role)
  const tool = worker.tools.find((item) => item.name === 'submit_result')!
  const submit = (raw: Record<string, unknown>) =>
    tool.execute('review', raw, undefined, undefined, {} as ExtensionToolContext)
  assert.equal(Check(tool.parameters, result), true)
  await submit(result)
  const prose = { ...engineeringReview, testing: { unscored: 'Prose only.' } }
  await assert.rejects(submit({ ...result, engineeringReview: prose }), /Score behavioral/)
  await assert.rejects(
    submit({
      ...result,
      engineeringReview,
      findings: [
        {
          severity: 'required',
          location: 'editor.ts',
          problem: 'Lost draft',
          evidence: 'Browser showed an empty saved draft.',
        },
      ],
    }),
    /required findings/,
  )
  await submit({ ...result, engineeringReview })
  const id = randomUUID()
  const workflowTaskId = randomUUID()
  const directory = delegationDirectory(store, id)
  const evidence = {
    role: 'implementer',
    model: role.model,
    snapshot: 'candidate',
    result: worker.result(),
  }
  await atomicJson(join(store.directory, 'tasks', workflowTaskId + '.json'), {
    evidence: [evidence],
  })
  await atomicJson(join(directory, 'status.json'), {
    status: 'complete',
    receiptAttempt: 'coordinator.json',
    workflowTaskId,
  })
  const reviewed = (await reviewReceipts(store, id)).reviews?.[0]
  assert.equal(reviewed?.testingScore, 100)
  assert.equal(reviewed?.snapshot, 'candidate')
  assert.deepEqual(reviewed?.engineeringReview, engineeringReview)
  await atomicJson(join(directory, 'status.json'), {
    status: 'running',
    receiptAttempt: 'previous.json',
    workflowTaskId,
  })
  assert.equal((await reviewReceipts(store, id)).reviews, null)
  request.changedFiles = ['README.md']
  await submit({ ...result, engineeringReview: prose })
  assert.deepEqual(worker.result()?.engineeringReview, prose)
})
