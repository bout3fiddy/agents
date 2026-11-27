import assert from 'node:assert/strict'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { runDelegation } from '../src/delegation-runner.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { registerGitHubRunWatch } from '../src/github-run-watch.ts'
import { registerHostWork, type AssignmentDesk } from '../src/host-work.ts'
import { digest } from '../src/paths.ts'
import { StateStore } from '../src/state.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'
import {
  ScriptedHost,
  arrived,
  call,
  continued,
  controls,
  dispatched,
  fastDelivery,
  fastTick,
  faultyWakes,
  finish,
  noFaults,
  privateAgentDirectory,
  quiet,
  receipts,
  record,
  records,
  registry,
  taskNamed,
  until,
  type Session,
  type Step,
} from './assignment-support.ts'

const document = {
  task: 'DOC: update notes.md',
  kind: 'documents',
  writePaths: ['notes.md'],
  context: '',
}
const dispatch: Step = () => [call('delegate_task', document)]
const wait: Step = (context) => [
  call('host_work', {
    outcome: 'Ship DOC',
    target: 'main checkout',
    state: 'waiting',
    detail: 'Accept the DOC result and deliver it.',
    sources: [{ task: dispatched(context, 'DOC') }],
  }),
]
const close: Step = () => [
  call('host_work', {
    assignment: 'a1',
    state: 'done',
    detail: 'Delivered.',
    evidence: { target: 'main checkout', revision: 'doc-r1' },
  }),
]

/** Close a1 whenever the runtime hands it back, by outcome or by continuation. */
function closesWhenHandedBack(start: Step[]) {
  return new ScriptedHost((self, texts) => {
    const handedBack =
      arrived(texts, 'Background task outcome.') ?? arrived(texts, 'The host owns the next step')

    if (handedBack && !self.closed.has('a1') && /a1/.test(handedBack)) {
      return [close]
    }

    return arrived(texts, 'Start DOC') ? start : undefined
  })
}

async function ended(session: Session, runtime: { settleCredentialWrites(): Promise<void> }) {
  await session.abort()
  session.dispose()
  await runtime.settleCredentialWrites()
}

// The escaped defect at the feed: an offered wake was recorded as delivered. The SDK starts the
// run asynchronously and reports a failed start only to its error channel, so the outcome was
// never offered again while Pi kept running. One attempt is the old behavior and the control.
for (const attempts of [1, 5]) {
  const name =
    attempts > 1 ? 'is offered again until acknowledged' : 'stays lost without a repeat (control)'

  test(`a dropped completion wake ${name}`, async (t) => {
    const { root, base } = await fixture()
    const faults = noFaults()
    faults.drop = 1
    const model = new ScriptedHost((_self, texts) =>
      arrived(texts, 'Start DOC') ? [dispatch] : undefined,
    )
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          registerDelegation(faultyWakes(pi, faults), async () => {}, undefined, {
            tickMs: fastTick,
            delivery: { ...fastDelivery, attempts },
          })
        },
      ],
      model.respond,
    )
    t.after(async () => {
      await ended(session, runtime)
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt('Start DOC.')
    await quiet(session)
    const jobs = registry(root)
    const id = await taskNamed(jobs, 'DOC')
    await finish(jobs, id, 'complete', 'DOC finished')

    // Longer than the first three repeat delays, so a repeat would have happened by now.
    await delay(600)
    await quiet(session)
    assert.equal(faults.dropped, 1, 'the first wake was dropped')
    assert.equal(receipts(session, id), attempts > 1 ? 1 : 0)
    assert.equal(model.shown('Background task outcome.', id), attempts > 1 ? 1 : 0)
  })
}

test('an assignment is handed back when every result wake is lost', async (t) => {
  const { root, base } = await fixture()
  const faults = noFaults()
  faults.drop = Number.MAX_SAFE_INTEGER
  const model = closesWhenHandedBack([dispatch, wait])
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        registerDelegation(faultyWakes(pi, faults), async () => {}, undefined, {
          assignments,
          tickMs: fastTick,
          delivery: fastDelivery,
        })
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await ended(session, runtime)
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Start DOC.')
  await quiet(session)
  const jobs = registry(root)
  const id = await taskNamed(jobs, 'DOC')
  await finish(jobs, id, 'complete', 'DOC finished')
  await until(async () => (await record(root, session, 'a1')).state === 'done', 'DOC delivery')
  await quiet(session)
  assert.ok(faults.dropped >= 1, 'result wakes were dropped')
  assert.equal(model.shown('The host owns the next step', `task ${id} complete`), 1)
  const wakes = session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-host-work-next')
  assert.deepEqual(
    wakes.map((entry) => (entry.type === 'custom_message' ? entry.details : undefined)),
    [{ assignments: ['a1'] }],
  )

  // The woken turn also received the outcome itself: appended once at its boundary, which
  // needs no wake. The host did not act a second time on the assignment it had just closed.
  assert.equal(receipts(session, id), 1)
  assert.equal(
    model.count('host_work', (args) => args.state === 'done'),
    1,
  )
  assert.equal((await record(root, session, 'a1')).attempts, 1)
})

/** What an outcome message gives the host to close a bound assignment with, if anything. */
function receiptEvidence(text: string, assignment: string) {
  const bindings = /recorded assignments: (\[.*?\])\. Continue/s.exec(text)?.[1]
  const bound = (
    JSON.parse(bindings ?? '[]') as { assignment: string; task: string; target: string }[]
  ).find((item) => item.assignment === assignment)
  const views = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as {
    id: string
    delivery?: { revision: string }
  }[]
  const revision = views.find((view) => view.id === bound?.task)?.delivery?.revision
  return bound && revision && text.includes('the receipt is its delivery evidence')
    ? { target: bound.target, revision }
    : undefined
}

// The escaped defect at live acceptance: a finished documents task handed its assignment back
// with nothing the host could cite. The host read the file, ran document_check, hashed it and
// only then closed: five requests where the completion gate allows three. The supervisor had
// already made those checks. Its receipt now arrives with the outcome, through the real
// supervisor and feed, and is enough to close. Without one (the control) nothing is offered.
for (const supervised of [true, false]) {
  const name = supervised
    ? 'a supervised documents result closes its assignment on the receipt alone'
    : 'a result without a supervisor receipt offers no delivery evidence (control)'

  test(name, async (t) => {
    const { root, base } = await fixture()
    const cited: unknown[] = []
    const model = new ScriptedHost((self, texts) => {
      const outcome = arrived(texts, 'Background task outcome.')

      if (outcome && !self.closed.has('a1')) {
        const evidence = receiptEvidence(outcome, 'a1')
        cited.push(evidence)
        return evidence
          ? [
              () => [
                call('host_work', {
                  assignment: 'a1',
                  state: 'done',
                  detail: 'The supervisor receipt covers the delivered document.',
                  evidence,
                }),
              ],
            ]
          : [close]
      }

      return arrived(texts, 'Start DOC') ? [dispatch, wait] : undefined
    })
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
          registerDelegation(pi, async () => {}, undefined, {
            assignments,
            tickMs: fastTick,
            delivery: fastDelivery,
          })
        },
      ],
      model.respond,
    )
    t.after(async () => {
      await ended(session, runtime)
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt('Start DOC.')
    await quiet(session)
    const jobs = registry(root)
    const id = await taskNamed(jobs, 'DOC')
    const before = model.requests.length
    const content = '# Notes\n\nCapacity is 100 and new jobs are rejected when full.\n'

    if (supervised) {
      const state = await runDelegation(
        new StateStore(root),
        id,
        new AbortController().signal,
        async (request) => {
          await writeFile(join(request.workspace, 'notes.md'), content)
          return {
            result: {
              verdict: 'pass',
              summary: 'DOC finished',
              findings: [],
              databaseImpact: false,
              evidence: ['Read back file'],
            },
            children: [],
            model: 'test/model',
            turns: 1,
            controlRevision: 0,
          }
        },
      )
      assert.equal(state.status, 'complete', state.error)
    } else {
      await finish(jobs, id, 'complete', 'DOC finished')
    }

    await until(async () => (await record(root, session, 'a1')).state === 'done', 'DOC delivery')
    await quiet(session)
    assert.deepEqual(model.errors, [])
    assert.equal(receipts(session, id), 1, 'one outcome message')

    // The live completion gate: the outcome is closed and acknowledged within three requests.
    assert.equal(model.requests.length - before, 2, 'close and acknowledge, nothing else')
    const evidence = (await record(root, session, 'a1')).evidence.at(-1)

    if (!supervised) {
      assert.deepEqual(cited, [undefined])
      assert.equal(model.shown('Background task outcome.', 'delivery.revision'), 0)
      assert.equal(evidence?.revision, 'doc-r1')
      return
    }

    // The receipt is the supervisor's: it names the bytes the checkout holds after its checks.
    const sha256 = digest(await readFile(join(root, 'notes.md')))
    const revision = digest(JSON.stringify([[['notes.md', sha256]], []]))
    assert.equal(sha256, digest(content))
    assert.deepEqual(cited, [{ target: 'main checkout', revision }])
    assert.deepEqual([evidence?.revision, evidence?.closes], [revision, true])
    assert.equal(model.shown('Background task outcome.', `"sha256":"${sha256}"`, '"words":'), 1)
  })
}

// A task belongs to the branch that started it unless an assignment record owns it. The
// unbound case is the control: it shows the binding is what carries delivery across the tree.
for (const bound of [false, true]) {
  test(`a ${bound ? 'bound' : 'unbound'} task result after the tree moved away`, async (t) => {
    const { root, base } = await fixture()
    const model = closesWhenHandedBack(bound ? [dispatch, wait] : [dispatch])
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
          registerDelegation(pi, async () => {}, undefined, {
            assignments,
            tickMs: fastTick,
            delivery: fastDelivery,
          })
        },
      ],
      model.respond,
    )
    t.after(async () => {
      await ended(session, runtime)
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt('Hello.')
    const earlier = session.sessionManager.getLeafId()!
    await session.prompt('Start DOC.')
    await quiet(session)
    const started = session.sessionManager.getLeafId()!
    const jobs = registry(root)
    const id = await taskNamed(jobs, 'DOC')
    await session.navigateTree(earlier, { summarize: false })
    await finish(jobs, id, 'complete', 'DOC finished')

    if (bound) {
      await until(async () => (await record(root, session, 'a1')).state === 'done', 'delivery')
      await quiet(session)
      assert.equal(receipts(session, id), 1)
      return
    }

    await delay(400)
    await quiet(session)
    assert.equal(receipts(session, id), 0, 'another branch does not receive an unbound outcome')
    await session.navigateTree(started, { summarize: false })
    await until(() => receipts(session, id) === 1, 'delivery on the originating branch')
    await quiet(session)
    assert.deepEqual(await records(root, session), [])
  })
}

test('a source that finished before it was bound keeps the assignment with the host', async (t) => {
  const { root, base } = await fixture()
  let id = ''
  const model = new ScriptedHost((self, texts) => {
    if (arrived(texts, 'Start DOC')) {
      return [dispatch]
    }

    if (arrived(texts, 'Track DOC')) {
      return [
        () => [
          call('host_work', {
            outcome: 'Ship DOC',
            target: 'main checkout',
            state: 'waiting',
            detail: 'Accept the DOC result and deliver it.',
            sources: [{ task: id }],
          }),
        ],
      ]
    }

    const handedBack = arrived(texts, 'The host owns the next step')
    return handedBack && continued(handedBack).length && !self.closed.has('a1')
      ? [close]
      : undefined
  })
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        registerDelegation(pi, async () => {}, undefined, {
          assignments,
          tickMs: fastTick,
          delivery: fastDelivery,
        })
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await ended(session, runtime)
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Start DOC.')
  await quiet(session)
  const jobs = registry(root)
  id = await taskNamed(jobs, 'DOC')
  await finish(jobs, id, 'complete', 'DOC finished')
  await until(() => receipts(session, id) === 1, 'the unbound outcome')
  await quiet(session)
  await session.prompt('Track DOC to delivery.')
  await quiet(session)
  assert.equal(model.shown('"state":"active"', 'Every bound source already finished'), 1)
  const item = await record(root, session, 'a1')
  assert.equal(item.state, 'done')
  assert.equal(item.attempts, 1)
  assert.equal(receipts(session, id), 1)
})

test('a watched run is a wake source; an unwatched one is not', async (t) => {
  const { root, base } = await fixture()
  let completed = false
  let desk: AssignmentDesk | undefined
  const source = { repository: 'fixture/project', runId: 75 }
  const waitForRun: Step = () => [
    call('host_work', {
      assignment: 'a1',
      state: 'waiting',
      detail: 'Deploy when run 75 is green.',
      sources: [source],
    }),
  ]
  const model = new ScriptedHost((self, texts) => {
    if (arrived(texts, 'Deploy after CI')) {
      return [
        () => [
          call('host_work', {
            outcome: 'Deploy the release',
            target: 'production',
            state: 'active',
            detail: 'Wait for CI, then deploy.',
          }),
        ],
        waitForRun,
        () => [call('watch_github_run', { ...source, followUp: 'Deploy the release.' })],
        waitForRun,
      ]
    }

    return arrived(texts, 'GitHub Actions watch finished.') && !self.closed.has('a1')
      ? [
          () => [
            call('host_work', {
              assignment: 'a1',
              state: 'done',
              detail: 'Deployed.',
              evidence: { target: 'production', revision: 'a'.repeat(40) },
            }),
          ],
        ]
      : undefined
  })
  const { session, runtime } = await captureSession(
    root,
    base,
    [
      (pi) => {
        const watches = registerGitHubRunWatch(
          pi,
          async () =>
            JSON.stringify({
              id: 75,
              status: completed ? 'completed' : 'in_progress',
              conclusion: completed ? 'success' : null,
              head_sha: 'a'.repeat(40),
              run_attempt: 1,
              run_started_at: null,
              updated_at: 'now',
            }),
          fastTick,
          fastDelivery,
        )
        desk = registerHostWork(pi, { watches, tickMs: fastTick, delivery: fastDelivery })
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await ended(session, runtime)
    await rm(base, { recursive: true, force: true })
  })
  await session.prompt('Hello.')
  const earlier = session.sessionManager.getLeafId()!
  await session.prompt('Deploy after CI run 75.')
  await quiet(session)
  assert.equal(model.shown('No watch is registered for fixture/project run 75'), 1)
  assert.equal((await record(root, session, 'a1')).state, 'waiting')
  assert.match(await desk!.view(desk!.current!), /a1 \[waiting · owner run fixture\/project#75\]/)

  // The watch and the assignment belong to the session, not to the branch that made them.
  await session.navigateTree(earlier, { summarize: false })
  completed = true
  await until(async () => (await record(root, session, 'a1')).state === 'done', 'deployment')
  await quiet(session)
  const item = await record(root, session, 'a1')
  assert.equal(item.attempts, 1)
  assert.match(item.history[0]!.status, /^completed\/success at a{12}$/)
  assert.equal(
    model.count('host_work', (args) => args.state === 'done'),
    1,
  )
  await session.prompt('/assignments')
})

// Routing is the dispatch itself. A task this session sent into another checkout through the
// task tool reports back without an assignment; tests/task-footer.test.ts holds the other half,
// that a task merely listed in the origin index stays display-only.
test('a task dispatched into another checkout reports back to its session', async (t) => {
  const host = await fixture()
  const other = await fixture()
  privateAgentDirectory(t, join(await realpath(host.base), 'agent'))
  const into = (project: string): Step => {
    return () => [call('delegate_task', { ...document, project })]
  }

  // A task workspace and a relative path are refused before anything is dispatched.
  const model = new ScriptedHost((_self, texts) =>
    arrived(texts, 'Start DOC')
      ? [into(join(other.root, '.pi')), into('other'), into(other.root)]
      : undefined,
  )
  const { session, runtime } = await captureSession(
    host.root,
    host.base,
    [
      (pi) => {
        registerDelegation(pi, async () => {}, undefined, {
          tickMs: fastTick,
          delivery: fastDelivery,
        })
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await ended(session, runtime)
    await rm(host.base, { recursive: true, force: true })
    await rm(other.base, { recursive: true, force: true })
  })
  await session.prompt('Start DOC in the other checkout.')
  await quiet(session)
  assert.equal(model.shown('private harness directories belong to their task'), 1)
  assert.equal(model.shown('project is the absolute path of a checkout or worktree root'), 1)
  const there = registry(other.root)
  const id = await taskNamed(there, 'DOC')
  assert.equal((await there.list()).length, 1, 'only the valid dispatch registered a task')
  assert.deepEqual(await registry(host.root).list(), [], 'nothing is registered locally')
  assert.equal(model.shown(`"project":"${await realpath(other.root)}"`), 1)
  await finish(there, id, 'complete', 'DOC finished elsewhere')
  await until(() => receipts(session, id) === 1, 'the routed outcome')
  await quiet(session)
  assert.equal(model.shown('Background task outcome.', 'DOC finished elsewhere'), 1)
})

test('a task of another session can neither wake nor be steered from this one', async (t) => {
  const host = await fixture()
  const other = await fixture()
  privateAgentDirectory(t, join(await realpath(host.base), 'agent'))
  const there = registry(other.root)
  const foreign = await there.start(
    { task: 'Someone else works here', kind: 'research', writePaths: [], context: '' },
    { session: 'another-session', model: 'test/model' },
    async () => {},
  )
  const id = foreign.request.id
  const model = new ScriptedHost((_self, texts) =>
    arrived(texts, 'Take over')
      ? [
          () => [
            call('host_work', {
              outcome: 'Take over their work',
              target: 'other checkout',
              state: 'waiting',
              detail: 'Wait for it.',
              sources: [{ task: id, project: other.root }],
            }),
          ],
          () => [call('task_control', { id, action: 'cancel', project: other.root })],
          () => [call('task_status', { id, project: other.root })],
        ]
      : undefined,
  )
  const { session, runtime } = await captureSession(
    host.root,
    host.base,
    [
      (pi) => {
        const assignments = registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
        registerDelegation(pi, async () => {}, undefined, { assignments, tickMs: fastTick })
      },
    ],
    model.respond,
  )
  t.after(async () => {
    await ended(session, runtime)
    await rm(host.base, { recursive: true, force: true })
    await rm(other.base, { recursive: true, force: true })
  })
  await session.prompt('Take over the task in the other checkout.')
  await quiet(session)
  assert.equal(model.shown('belongs to another session and cannot wake this one'), 1)
  assert.equal(model.shown('belongs to another session; steer it from there'), 1)
  assert.equal(model.shown('"task":"Someone else works here"', '"state":"queued"'), 1)
  assert.deepEqual(await records(host.root, session), [])
  assert.equal((await controls(there, id)).cancelled, false)
})

// Host work recorded by the earlier latest-entry scheme is carried forward when the session is
// next loaded: bound to its task when one can be found, otherwise blocked and visible.
for (const tracked of [true, false]) {
  const kind = tracked ? 'bound to its tracked task' : 'blocked and visible'

  test(`a legacy wait is carried forward ${kind}`, async (t) => {
    const { root, base } = await fixture()
    let upgraded = false
    let id = ''
    const model = closesWhenHandedBack([dispatch])
    const { session, runtime } = await captureSession(
      root,
      base,
      [
        (pi) => {
          const assignments = upgraded
            ? registerHostWork(pi, { tickMs: fastTick, delivery: fastDelivery })
            : undefined
          registerDelegation(pi, async () => {}, undefined, {
            assignments,
            tickMs: fastTick,
            delivery: fastDelivery,
          })

          // What the earlier version wrote: one entry, authoritative while latest on its branch.
          pi.registerCommand('legacy-wait', {
            description: 'Record host work as the earlier version did',
            async handler(_args, ctx) {
              pi.appendEntry('pi-host-work', {
                state: 'waiting',
                detail: tracked ? `Deliver DOC when task ${id} completes.` : 'Deliver DOC later.',
                session: ctx.sessionManager.getSessionId(),
              })
            },
          })
        },
      ],
      model.respond,
    )
    t.after(async () => {
      await ended(session, runtime)
      await rm(base, { recursive: true, force: true })
    })
    await session.prompt('Start DOC.')
    await quiet(session)
    const jobs = registry(root)
    id = await taskNamed(jobs, 'DOC')
    await session.prompt('/legacy-wait')
    upgraded = true
    await session.reload()
    await session.prompt('What is open?')
    await quiet(session)
    const carried = await record(root, session, 'a1')
    assert.equal(carried.legacy, true)
    assert.equal(carried.state, tracked ? 'waiting' : 'blocked')
    assert.equal(carried.blocker?.kind, tracked ? undefined : 'legacy')
    assert.equal(model.shown('Assignments recorded for this session', 'Deliver DOC'), 1)
    assert.equal((await controls(jobs, id)).cancelled, false, 'the in-flight task keeps running')

    if (!tracked) {
      return
    }

    // The in-flight task still wakes the host, now through the carried record.
    await finish(jobs, id, 'complete', 'DOC finished')
    await until(async () => (await record(root, session, 'a1')).attempts === 1, 'the outcome')
    await quiet(session)
    assert.equal(receipts(session, id), 1)
  })
}
