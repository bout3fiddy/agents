import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Type } from 'typebox'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { hostWorkPaused, registerHostWork, type AssignmentDesk } from '../src/host-work.ts'
import { AssignmentStore } from '../src/assignments.ts'
import { textResult } from '../src/file-tools.ts'
import { StateStore } from '../src/state.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import {
  continued,
  fastDelivery,
  fastTick,
  finish,
  plain,
  quiet,
  registry,
  say,
  until,
} from './assignment-support.ts'

type Session = Awaited<ReturnType<typeof captureSession>>['session']
type Arguments = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments']

const opening = { outcome: 'Publish the service', target: 'staging cluster' }
const delivered = { target: 'staging cluster', revision: 'release-7' }

/** The records as stored, read independently of the session that wrote them. */
function records(root: string, session: Session) {
  const store = new AssignmentStore(
    new StateStore(root).directory,
    session.sessionManager.getSessionId(),
  )
  return store.read().then((ledger) => ledger.records)
}

function hostWork(id: string, args: Arguments) {
  return [{ type: 'toolCall' as const, name: 'host_work', id, arguments: args }]
}

for (const outcome of ['done', 'stalled', 'blocked', 'paused']) {
  test('host assignment reaches ' + outcome + ' through the Pi settlement boundary', async (t) => {
    const { root, base } = await fixture()
    let modelSteps = 0
    let advances = 0
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerHostWork(pi)
          pi.registerTool({
            name: 'stage_service',
            label: 'Stage service',
            description: 'Stage fixture',
            parameters: Type.Object({}),
            async execute() {
              advances++
              return textResult('healthy')
            },
          })
        },
      ],
      async () => {
        modelSteps++
        const id = String(modelSteps)

        if (modelSteps === 1) {
          return hostWork(id, {
            ...opening,
            state: 'active',
            detail: 'Publish service. Verify it responds.',
          })
        }

        // The user's own line below confirms the pause; without it the call would be refused.
        if (modelSteps === 2 && outcome === 'paused') {
          return hostWork(id, { state: 'paused', detail: 'The user asked to stop.' })
        }

        if (modelSteps === 2 && outcome === 'blocked') {
          return hostWork(id, {
            state: 'blocked',
            detail: 'Publish once the key arrives.',
            retry: { blocker: 'Release owner holds the key.', resumeWhen: 'the key is shared.' },
          })
        }

        if (modelSteps === 3 && outcome === 'done') {
          return [{ type: 'toolCall', name: 'stage_service', id: 'stage', arguments: {} }]
        }

        if (modelSteps === 4 && outcome === 'done') {
          return hostWork(id, {
            state: 'done',
            detail: 'Live probe returned healthy.',
            evidence: delivered,
          })
        }

        assert.ok(modelSteps < 7, 'Repeated continuation without progress')
        return [{ type: 'text', text: 'The machine is up. Application setup is next.' }]
      },
    )
    t.after(async () => {
      await session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt(
      'Launch the service and verify it.' + (outcome === 'paused' ? '\npause a1' : ''),
    )
    await session.waitForIdle()
    const entries = session.sessionManager.getBranch()
    const count = (name: string) =>
      entries.filter((e) => e.type === 'custom_message' && e.customType === name).length
    assert.equal(advances, Number(outcome === 'done'))
    assert.equal(count('pi-host-work-next'), Number(outcome === 'done' || outcome === 'stalled'))
    assert.equal(count('pi-host-work-stalled'), Number(outcome === 'stalled'))
    assert.equal(session.messages.findLast((m) => m.role === 'assistant')?.stopReason, 'stop')
    const [record] = await records(root, session)
    assert.equal(record?.state, outcome === 'stalled' ? 'blocked' : outcome)
    assert.equal(record?.blocker?.kind, outcome === 'stalled' ? 'stalled' : undefined)
    assert.equal(record?.evidence.at(-1)?.closes, outcome === 'done' ? true : undefined)
  })
}

test('an ordinary status question leaves a blocked assignment blocked across reload', async (t) => {
  const { root, base } = await fixture()
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi)
      },
    ],
    async (ctx) => {
      step++

      if (step === 1) {
        return hostWork('wait', {
          outcome: 'Publish the authorized preview',
          target: 'preview environment',
          state: 'blocked',
          detail: 'Publish as soon as the manifest is signed.',
          retry: {
            blocker: 'Release owner must provide the signed manifest.',
            resumeWhen: 'the signed manifest is in the release folder.',
          },
        })
      }

      if (step === 3) {
        const context = JSON.stringify(ctx.messages)
        assert.match(context, /Release owner must provide the signed manifest/)
        assert.equal(context.split('Assignments recorded for this session').length - 1, 1)
      }

      assert.ok(step <= 3)
      return [{ type: 'text', text: 'Waiting for the signed manifest.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Continue the authorized preview as soon as release signs the manifest.')
  await session.waitForIdle()
  await session.reload()
  await session.prompt('Status only.')
  await session.waitForIdle()
  assert.equal(step, 3)
  assert.equal(session.messages.findLast((m) => m.role === 'assistant')?.stopReason, 'stop')
  assert.ok(
    !session.sessionManager
      .getBranch()
      .some((e) => e.type === 'custom_message' && e.customType === 'pi-host-work-next'),
  )
  assert.equal((await records(root, session))[0]?.state, 'blocked')
})

// An interrupt stops the turn. It pauses nothing: the record stays active, the next question is
// answered and the host is then asked to continue what it still owns. The cases with several
// assignments and the confirmed pause are in tests/assignment-authority.test.ts.
test('interrupting a host operation leaves its assignment active and recorded', async (t) => {
  const { root, base } = await fixture()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let steps = 0
  let desk: AssignmentDesk | undefined
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        desk = registerHostWork(pi)
        pi.registerTool({
          name: 'await_service',
          label: 'Await service',
          description: 'Hold until interrupted',
          parameters: Type.Object({}),
          async execute(_id, _input, signal) {
            started()

            if (!signal?.aborted) {
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true }),
              )
            }

            return textResult('Interrupted.')
          },
        })
      },
    ],
    async () => {
      steps++

      if (steps === 1) {
        return hostWork('open', {
          outcome: 'Bring up the test service',
          target: 'local test service',
          state: 'active',
          detail: 'Start the service and probe it.',
        })
      }

      if (steps === 2) {
        return [{ type: 'toolCall', id: 'wait', name: 'await_service', arguments: {} }]
      }

      if (steps === 4) {
        return hostWork('park', {
          state: 'blocked',
          detail: 'Start the service and probe it.',
          retry: { blocker: 'The user is deciding.', resumeWhen: 'the user says to go on.' },
        })
      }

      return [{ type: 'text', text: 'Ready for discussion.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const request = session.prompt('Bring up the test service.')
  await entered
  await session.abort()
  await request
  await session.waitForIdle()
  assert.equal(steps, 2, 'the interrupt started no further request')
  const [interrupted] = await records(root, session)
  assert.deepEqual([interrupted?.state, interrupted?.owner], ['active', 'host'])
  assert.equal(interrupted?.next, 'Start the service and probe it.')
  await session.reload()
  assert.deepEqual(await records(root, session), [interrupted], 'a reload changes nothing')

  // Automatic wakes that respect a paused host read the same records: nothing is paused.
  assert.equal(hostWorkPaused(desk!.current!), false)

  // The answer (3) is followed by one continuation for the assignment the host still owns (4),
  // which records why it is not advancing, and the closing reply (5).
  await session.prompt('Status only. What was the last step?')
  await session.waitForIdle()
  assert.equal(steps, 5)
  const [record] = await records(root, session)
  assert.deepEqual([record?.state, record?.owner], ['blocked', 'external'])
  assert.equal(record?.next, 'Start the service and probe it.')
})

test('first retry explains the blocker before the next attempt and survives reload', async (t) => {
  const { root, base } = await fixture()
  const first = { blocker: 'The endpoint returned the old revision.', resumeWhen: 'it serves v2.' }
  const second = { blocker: 'The readiness endpoint returned 503.', resumeWhen: 'it returns 200.' }
  const release = { outcome: 'Release version two', target: 'production endpoint' }
  let step = 0
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi)
      },
    ],
    async () => {
      step++
      const record = (state: string, extra: Arguments = {}) =>
        hostWork(String(step), { state, detail: 'Release version two.', ...extra })

      if (step === 1) {
        return record('blocked', { ...release, retry: first })
      }

      if (step === 3) {
        return record('blocked', { retry: first })
      }

      if (step === 4) {
        return record('active', { retry: second })
      }

      if (step === 5) {
        return record('done', { evidence: { target: release.target, revision: 'v2' } })
      }

      assert.ok(step === 2 || step === 6)
      return [{ type: 'text', text: 'Checkpoint recorded.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  const notice = (retry: typeof first) =>
    `${release.outcome} (a1)\n${retry.blocker}\nResume condition · ${retry.resumeWhen}`
  const notices = () =>
    session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === 'custom_message' &&
        entry.customType === 'pi-host-work-blocker' &&
        entry.display
          ? [entry.content]
          : [],
      )
  await session.prompt('Start release.')
  await session.waitForIdle()
  assert.deepEqual(notices(), [notice(first)])
  await session.reload()
  await session.prompt('Resume the release and record readiness.')
  await session.waitForIdle()
  assert.equal(step, 6)
  assert.deepEqual(notices(), [notice(first), notice(second)])
  const branch = session.sessionManager.getBranch()
  const visible = branch.findIndex(
    (e) =>
      e.type === 'custom_message' &&
      e.customType === 'pi-host-work-blocker' &&
      e.content === notices()[1],
  )
  const done = branch.findIndex(
    (e) =>
      e.type === 'custom' &&
      e.customType === 'pi-host-work' &&
      (e.data as { state: string }).state === 'done',
  )
  assert.ok(visible >= 0 && visible < done)
})

// The escaped defect: host work was the latest record on the current branch, so opening a
// second task replaced the first and navigating the tree changed which one existed.
test('a second assignment and a tree change leave the first one recorded', async (t) => {
  const { root, base } = await fixture()
  let step = 0

  // Both outcomes stated together in one message: the record context, not the transcript.
  let statedTogether = false
  const blocked = (outcome: string, missing: string) => ({
    outcome,
    target: 'production',
    state: 'blocked',
    detail: `Continue ${outcome}.`,
    retry: { blocker: missing, resumeWhen: 'it is provided.' },
  })
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi)
      },
    ],
    async (ctx) => {
      step++
      statedTogether = ctx.messages.some((message) => {
        const stated = JSON.stringify(message.content)
        return (
          message.role !== 'assistant' &&
          stated.includes('FIRST_OUTCOME') &&
          stated.includes('SECOND_OUTCOME')
        )
      })

      if (step === 1) {
        return hostWork('first', blocked('FIRST_OUTCOME', 'The database credentials.'))
      }

      if (step === 3) {
        return hostWork('second', blocked('SECOND_OUTCOME', 'The DNS delegation.'))
      }

      return [{ type: 'text', text: 'Recorded.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Start the first job.')
  await session.waitForIdle()
  const beforeSecond = session.sessionManager.getLeafId()!
  await session.prompt('Unrelated: also start a second job.')
  await session.waitForIdle()
  await session.prompt('Side question: what is open?')
  await session.waitForIdle()
  assert.ok(statedTogether, 'opening a second assignment keeps the first in context')

  // Navigate to before the second job was opened. Its record does not live on that branch.
  await session.navigateTree(beforeSecond, { summarize: false })
  await session.prompt('Back on the earlier branch: what is open?')
  await session.waitForIdle()
  assert.ok(statedTogether, 'another branch still sees both assignments')
  assert.deepEqual(
    (await records(root, session)).map((record) => [record.id, record.state]),
    [
      ['a1', 'blocked'],
      ['a2', 'blocked'],
    ],
  )
})

/** The assignments named by the newest continuation in front of the host. */
function asked(context: Context): string[] {
  const text = context.messages
    .map((message) => plain(message))
    .findLast((item) => item.includes('The host owns the next step'))
  return text ? continued(text).map((item) => item.assignment) : []
}

/** What each continuation or stall notice persisted in the session names, in order. */
function named(session: Session, customType: string) {
  return session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'custom_message' && entry.customType === customType ? [entry.details] : [],
    )
}

const hostError = 'The host run ended with an error.'
const noAction = 'A host continuation produced no action.'

// The escaped defect: a host run that failed, or answered a continuation without acting,
// blocked every active assignment. An assignment that run was never asked about, here one its
// worker handed back while the run was under way, got the same blocker and nothing continued it.
for (const failure of ['no action', 'an error'] as const) {
  const title = `a run ending in ${failure} on one assignment leaves a ready one to continue`

  test(title, async (t) => {
    const { root, base } = await fixture()
    const jobs = registry(root)
    let task = ''
    let step = 0
    const continuations: string[][] = []
    const offered: unknown[] = []
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        },
      ],
      async (context) => {
        step++

        if (step === 1) {
          return hostWork('deploy', {
            outcome: 'Deploy the service',
            target: 'staging cluster',
            state: 'active',
            detail: 'Deploy and probe.',
          })
        }

        if (step === 2) {
          return hostWork('doc', {
            outcome: 'Ship DOC',
            target: 'main checkout',
            state: 'waiting',
            detail: 'Accept the DOC result and deliver it.',
            sources: [{ task }],
          })
        }

        if (step === 3) {
          return say('Both are under way.')
        }

        continuations.push(asked(context))

        // The continuation names a1 alone. DOC ends while the host is answering it.
        if (step === 4) {
          await finish(jobs, task, 'complete', 'DOC finished')

          if (failure === 'an error') {
            throw new Error('scripted provider failure')
          }

          return say('Nothing further to do.')
        }

        if (step === 5) {
          const second = (await records(root, session))[1]
          offered.push([second?.state, second?.blocker?.kind])
          return hostWork('close', {
            assignment: 'a2',
            state: 'done',
            detail: 'Delivered.',
            evidence: { target: 'main checkout', revision: 'doc-r1' },
          })
        }

        return say('DOC is delivered.')
      },
    )
    t.after(async () => {
      await session.abort()
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    })
    const started = await jobs.start(
      { task: 'DOC: update notes.md', kind: 'documents', writePaths: ['notes.md'], context: '' },
      { session: session.sessionManager.getSessionId(), model: 'capture/capture' },
      async () => {},
    )
    task = started.request.id
    await session.prompt('Start both.')
    await until(async () => (await records(root, session))[1]?.state === 'done', 'DOC delivery')
    await quiet(session)

    // Longer than the hand-back grace period and its first repeats: nothing further is asked.
    await delay(20 * fastTick + 4 * fastDelivery.retryMs)
    await session.waitForIdle()
    const [first, second] = await records(root, session)
    assert.deepEqual(
      [first?.state, first?.blocker?.kind, first?.blocker?.blocker],
      ['blocked', 'stalled', failure === 'an error' ? hostError : noAction],
      'the assignment the run answered for says why it stopped',
    )
    assert.equal(second?.state, 'done')
    assert.deepEqual(offered, [['active', undefined]], 'the other was put to the host as ready')
    assert.deepEqual(continuations.slice(0, 2), [['a1'], ['a2']], 'each was asked on its own')
    assert.deepEqual(named(session, 'pi-host-work-next'), [
      { assignments: ['a1'] },
      { assignments: ['a2'] },
    ])
    assert.deepEqual(
      named(session, 'pi-host-work-stalled'),
      failure === 'no action' ? [{ assignments: ['a1'] }] : [],
    )
    assert.equal(step, 6, 'each assignment was put to the host once')
  })
}

// The same defect one step further in: two assignments are both ready for the host, and the
// continuation names one of them. The other was left active by an interrupt, so the model had
// been shown it, and the stall took every shown record: it was blocked for an answer to a
// question that never named it. A failed run stalls what its continuation named and nothing
// else, and the other assignment is then asked on its own and delivered.
for (const failure of ['no action', 'an error'] as const) {
  const title = `a continuation ending in ${failure} stalls only the assignment it names`

  test(title, async (t) => {
    const { root, base } = await fixture()
    const jobs = registry(root)
    let task = ''
    let step = 0
    let entered!: () => void
    const holding = new Promise<void>((resolve) => {
      entered = resolve
    })
    const continuations: string[][] = []
    const offered: unknown[] = []
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
          pi.registerTool({
            name: 'await_service',
            label: 'Await service',
            description: 'Hold until interrupted',
            parameters: Type.Object({}),
            async execute(_id, _input, signal) {
              entered()

              if (!signal?.aborted) {
                await new Promise<void>((resolve) =>
                  signal?.addEventListener('abort', () => resolve(), { once: true }),
                )
              }

              return textResult('Interrupted.')
            },
          })
        },
      ],
      async (context) => {
        step++

        if (step === 1) {
          return hostWork('deploy', { ...opening, state: 'active', detail: 'Deploy and probe.' })
        }

        if (step === 2) {
          return hostWork('doc', {
            outcome: 'Ship DOC',
            target: 'main checkout',
            state: 'waiting',
            detail: 'Accept the DOC result and deliver it.',
            sources: [{ task }],
          })
        }

        // Interrupted below: a1 stays active and shown, with no continuation naming it.
        if (step === 3) {
          return [{ type: 'toolCall', id: 'hold', name: 'await_service', arguments: {} }]
        }

        continuations.push(asked(context))

        // DOC was handed back while the host was idle. This continuation names a2 alone.
        if (step === 4) {
          if (failure === 'an error') {
            throw new Error('scripted provider failure')
          }

          return say('Nothing further to do.')
        }

        if (step === 5) {
          const first = (await records(root, session))[0]
          offered.push([first?.state, first?.blocker?.kind])
          return hostWork('close', {
            assignment: 'a1',
            state: 'done',
            detail: 'Live probe returned healthy.',
            evidence: delivered,
          })
        }

        return say('The service is published.')
      },
    )
    t.after(async () => {
      await session.abort()
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(base, { recursive: true, force: true })
    })
    const started = await jobs.start(
      { task: 'DOC: update notes.md', kind: 'documents', writePaths: ['notes.md'], context: '' },
      { session: session.sessionManager.getSessionId(), model: 'capture/capture' },
      async () => {},
    )
    task = started.request.id
    const request = session.prompt('Start both.')
    await holding
    await session.abort()
    await request
    await session.waitForIdle()
    assert.equal(step, 3, 'the interrupt started no further request')
    assert.deepEqual(
      (await records(root, session)).map((record) => record.state),
      ['active', 'waiting'],
    )
    await finish(jobs, task, 'complete', 'DOC finished')
    await until(async () => (await records(root, session))[0]?.state !== 'active', 'a1 to settle')
    await quiet(session)

    // Longer than the hand-back grace period and its first repeats: nothing further is asked.
    await delay(20 * fastTick + 4 * fastDelivery.retryMs)
    await session.waitForIdle()
    const [first, second] = await records(root, session)
    assert.deepEqual(
      [second?.state, second?.blocker?.kind, second?.blocker?.blocker],
      ['blocked', 'stalled', failure === 'an error' ? hostError : noAction],
      'the assignment the continuation named says why it stopped',
    )
    assert.deepEqual(offered, [['active', undefined]], 'the other was put to the host as ready')
    assert.equal(first?.state, 'done', 'the assignment that run never named was delivered')
    assert.deepEqual(continuations.slice(0, 2), [['a2'], ['a1']], 'each was asked on its own')
    assert.deepEqual(named(session, 'pi-host-work-next'), [
      { assignments: ['a2'] },
      { assignments: ['a1'] },
    ])
    assert.deepEqual(
      named(session, 'pi-host-work-stalled'),
      failure === 'no action' ? [{ assignments: ['a2'] }] : [],
    )
    assert.equal(step, 6, 'each assignment was put to the host once')
  })
}

// An error in a run that no continuation started belongs to the session, not to an assignment.
// The record stays active and is offered once more. A second error, now in the continuation that
// names it, is its blocker, so a failing provider is asked once and never in a loop.
test('a run error nothing attributes blocks no assignment and is retried once', async (t) => {
  const { root, base } = await fixture()
  let step = 0
  const offered: unknown[] = []
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
      },
    ],
    async () => {
      step++

      if (step === 1) {
        return hostWork('open', { ...opening, state: 'active', detail: 'Publish service.' })
      }

      if (step === 3) {
        const [record] = await records(root, session)
        offered.push([record?.state, record?.blocker?.kind])
      }

      throw new Error('scripted provider failure')
    },
  )
  t.after(async () => {
    await session.abort()
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Launch the service.')
  await until(() => step === 3, 'the one further offer')
  await quiet(session)
  await delay(20 * fastTick + 8 * fastDelivery.retryMs)
  await session.waitForIdle()
  assert.equal(step, 3, 'the failing host is offered the assignment once more, not in a loop')
  assert.deepEqual(offered, [['active', undefined]], 'the first error blocked nothing')
  assert.deepEqual(named(session, 'pi-host-work-next'), [{ assignments: ['a1'] }])
  const [record] = await records(root, session)
  assert.deepEqual(
    [record?.state, record?.blocker?.kind, record?.blocker?.blocker],
    ['blocked', 'stalled', hostError],
  )
})

test('host_work rejects a wait with no registered source and records nothing', async (t) => {
  const { root, base } = await fixture()
  let step = 0
  let rejection = ''
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        registerHostWork(pi)
      },
    ],
    async (ctx) => {
      step++

      if (step === 1) {
        return hostWork('wait', {
          outcome: 'Publish the preview',
          target: 'preview environment',
          state: 'waiting',
          detail: 'Someone will tell me when the manifest is signed.',
        })
      }

      rejection ||= JSON.stringify(ctx.messages.at(-1))
      return [{ type: 'text', text: 'Understood.' }]
    },
  )
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Wait for the manifest.')
  await session.waitForIdle()
  assert.match(rejection, /Waiting needs a registered wake source/)
  assert.deepEqual(await records(root, session), [])
})
