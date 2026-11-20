import { transcriptTurns } from '../src/workers-transcript.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { visibleWidth, type OverlayOptions } from '@earendil-works/pi-tui'
import type { Theme, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'
import { LiveWorker } from '../src/worker-live.ts'
import { attachLiveSession } from '../src/worker-live-session.ts'
import { WorkersCatalog } from '../src/workers-data.ts'
import { WorkersView, terminalText } from '../src/workers-ui.ts'
import { workerTree } from '../src/workers-tree.ts'
import { registerWorkers } from '../src/workers-command.ts'
import { Delegations, delegationDirectory, type TaskControls } from '../src/delegation-state.ts'
import { atomicJson, readJson, StateStore } from '../src/state.ts'

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme

async function live(root: string, role = 'task-worker', parentId?: string, reviewOf?: string) {
  return LiveWorker.start(root, {
    role,
    model: 'test/model',
    task: 'Update the queue design without changing persistence.',
    scope: ['design.md'],
    output: join(root, '.pi/traces/harness', `${role}.json`),
    workspace: root,
    backend: 'pi',
    parentId,
    reviewOf,
  })
}

test('guidance preserves text, prevents premature completion and rejects late sends', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  const text = 'Use exactly: two words, café 🧪\nKeep this newline.'
  const message = await worker.mailbox.send(text)
  assert.equal(await worker.mailbox.seal(), false)
  let submitted = false
  const boundary = await worker.mailbox.toolBoundary(true, async () => {
    submitted = true
  })
  assert.equal(boundary.blocked, true)
  assert.equal(submitted, false)
  assert.equal(boundary.messages[0]?.text, text)
  assert.equal((await worker.mailbox.read()).messages[0]?.id, message.id)
  await worker.mailbox.toolBoundary(true, async () => {
    submitted = true
  })
  assert.equal(submitted, true)
  await assert.rejects(worker.mailbox.send('Too late'), /finished accepting/)
  await worker.finish('complete', 'Done')
})

test('guidance arrives during long tools and interrupts only the next safe boundary', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const starting = new Promise<void>((resolve) => {
    started = resolve
  })
  const running = worker.mailbox.toolBoundary(false, async () => {
    started()
    await gate
    return 7
  })
  await starting
  await worker.mailbox.send('Please check recovery next.')
  release()
  const completed = await running
  assert.equal(completed.blocked, false)
  assert.equal(completed.messages[0]?.status, 'delivered')
  await worker.mailbox.send('Do not execute the proposed edit yet.')
  let called = false
  assert.equal(
    (
      await worker.mailbox.toolBoundary(false, async () => {
        called = true
      })
    ).blocked,
    true,
  )
  assert.equal(called, false)
  await worker.finish('complete', 'Done')
})

test('sending and sealing race without losing accepted guidance', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))

  for (let index = 0; index < 6; index++) {
    const worker = await live(item.root)
    const [send, seal] = await Promise.allSettled([
      worker.mailbox.send(`Guidance ${index}`),
      worker.mailbox.seal(),
    ])
    assert.equal(seal.status, 'fulfilled')

    if (send.status === 'fulfilled') {
      assert.equal(seal.status === 'fulfilled' && seal.value, false)
      assert.equal((await worker.mailbox.read()).messages[0]?.text, `Guidance ${index}`)
    } else {
      assert.match(String(send.reason), /finished accepting/)
      assert.equal(seal.status === 'fulfilled' && seal.value, true)
    }

    await worker.finish('complete', 'Done')
  }
})

test('the real Pi SDK consumes live guidance without changing sessions or aborting', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let calls = 0
  let observed = false
  const { session, runtime } = await captureSession(item.root, item.base, [], async (context) => {
    calls++

    if (calls === 1) {
      entered()
      await gate
    }

    observed ||= JSON.stringify(context.messages).includes('Use capacity 120 instead.')
    return [{ type: 'text', text: observed ? 'Capacity changed to 120.' : 'Working.' }]
  })
  const worker = await live(item.root)
  let invalidations = 0
  const attached = attachLiveSession(session, worker, () => {
    invalidations++
  })
  t.after(async () => {
    await attached.dispose()
    session.dispose()
    await runtime.settleCredentialWrites()
  })
  const id = session.sessionManager.getSessionId()
  const running = session.prompt('Record capacity 100.')
  await started
  await worker.mailbox.send('Use capacity 120 instead.')
  await attached.settleGuidance()
  assert.equal(session.isStreaming, true)
  release()
  await running
  await session.waitForIdle()
  await attached.settleGuidance()
  assert.equal(observed, true)
  assert.ok(invalidations > 0)
  assert.equal((await worker.mailbox.read()).messages[0]?.status, 'delivered')
  assert.equal(session.sessionManager.getSessionId(), id)
  assert.equal(await worker.mailbox.seal(), true)
  await worker.finish('complete', 'Capacity updated')
})

test('worker hierarchy keeps completed authors beside their active reviewers', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const parent = await live(item.root, 'task-coordinator')
  const author = await live(item.root, 'implementer', parent.info.id)
  await author.finish('complete', 'Implementation ready')
  const reviewer = await live(item.root, 'reviewer', parent.info.id, author.info.id)
  const catalog = new WorkersCatalog(item.root)
  const nodes = workerTree(await catalog.list(), true)
  assert.deepEqual(
    nodes.map((node) => [node.row.info.role, node.depth, node.context]),
    [
      ['task-coordinator', 0, false],
      ['implementer', 1, true],
      ['reviewer', 2, false],
    ],
  )
  const past = workerTree(await catalog.list(), false)
  assert.deepEqual(
    past.map((node) => node.row.id),
    [parent.info.id, author.info.id],
  )
  await assert.rejects(catalog.send(author.info.id, 'Too late'), /no longer accepting/)
  await parent.finish('complete', 'Done')
  await reviewer.finish('complete', 'Pass')
})

test('viewer reads partial traces safely and keeps corrupt workers isolated', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  await worker.append('assistant', 'Hello 🧪, these words stay separated.\nSecond line.')
  const catalog = new WorkersCatalog(item.root)
  const row = (await catalog.list())[0]!
  await writeFile(join(worker.directory, 'conversation.jsonl'), '{"partial":', { flag: 'a' })
  assert.equal((await catalog.conversation(row)).entries.length, 1)
  const other = await live(item.root, 'reviewer')
  await rm(join(other.directory, 'state.json'))
  await symlink(join(item.base, 'private.json'), join(other.directory, 'state.json'))
  await writeFile(join(item.base, 'private.json'), '{"secret":"must never render"}')
  assert.equal((await catalog.list()).length, 1)
  assert.match(catalog.warnings.join(''), /Linked worker traces/)
  await worker.finish('complete', 'Done')
})

test('picker handles guidance, completion, Unicode, resizing and exit', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  await worker.append('assistant', 'Working on café 🧪 and 長い文章.\nNo extra UI notices.')
  let closed = false
  const view = new WorkersView(
    new WorkersCatalog(item.root),
    plainTheme,
    () => 24,
    () => {},
    () => {
      closed = true
    },
    false,
    false,
  )
  t.after(() => view.dispose())
  await view.refresh()
  view.focused = true
  view.handleInput('\r')
  await delay(50)
  await view.refresh()
  assert.equal(view.conversationId, worker.info.id)
  view.handleInput('d')
  assert.match(view.render(80).join('\n'), /Repository|Worker:/)
  view.handleInput('p')
  assert.match(view.render(80).join('\n'), /Update the queue design/)
  view.handleInput('g')
  view.handleInput('Keep the exact phrase: café test.')
  view.handleInput('\r')

  for (let index = 0; index < 100 && !(await worker.mailbox.read()).messages.length; index++) {
    await delay(20)
  }

  assert.equal((await worker.mailbox.read()).messages[0]?.text, 'Keep the exact phrase: café test.')

  for (const width of [20, 40, 80, 140]) {
    assert.ok(view.render(width).every((line) => visibleWidth(line) <= width))
  }

  view.handleInput('\x1b')
  await worker.finish('complete', 'Done')
  await view.refresh()
  assert.match(view.render(80).join('\n'), /complete/)
  assert.match(view.render(80).join('\n'), /not delivered; worker stopped/)
  view.handleInput('\x1b')
  view.handleInput('\t')
  assert.match(view.render(80).join('\n'), /\[Past 1\]/)
  view.handleInput('\x0f')
  assert.equal(closed, true)
  assert.equal(terminalText('\x1b]52;c;malicious\x07safe\x1b[2J'), 'safe')
})

test('/workers opens during a real SDK request without stopping host or worker', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let requests = 0
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [registerWorkers],
    async () => {
      requests++
      entered()
      await gate
      return [{ type: 'text', text: 'Host finished' }]
    },
  )
  let view: WorkersView | undefined
  let options: OverlayOptions | undefined
  const ui = {
    custom: async (factory: Function, configuration: { overlayOptions: OverlayOptions }) =>
      new Promise<void>((resolve) => {
        options = configuration.overlayOptions
        view = factory({ terminal: { rows: 24 }, requestRender() {} }, plainTheme, {}, () => {
          view?.dispose()
          resolve()
        })
      }),
    notify() {},
  } as unknown as ExtensionUIContext
  await session.bindExtensions({ mode: 'tui', uiContext: ui })
  t.after(async () => {
    view?.dispose()
    session.dispose()
    await runtime.settleCredentialWrites()
  })
  const id = session.sessionManager.getSessionId()
  const running = session.prompt('Continue the design discussion.')
  await started
  const picker = session.prompt('/workers')

  for (let index = 0; index < 100; index++) {
    if (view) {
      break
    }

    await delay(10)
  }

  assert.ok(view)
  await view.refresh()
  await worker.append('assistant', 'Worker continues while the picker is open.')
  view.handleInput('\r')
  await delay(50)
  await view.refresh()
  assert.match(view.render(100).join('\n'), /Worker continues/)
  assert.equal(session.isStreaming, true)
  view.handleInput('\x0f')
  await picker
  assert.equal(session.isStreaming, true)
  assert.equal((await new WorkersCatalog(item.root).list())[0]?.active, true)
  await session.prompt('/workers panel')
  assert.equal(options?.nonCapturing, true)
  assert.equal(options?.visible?.(119, 24), false)
  assert.equal(options?.visible?.(120, 24), true)
  assert.equal(session.isStreaming, true)
  await session.prompt('/workers panel')
  release()
  await running
  assert.equal(requests, 1)
  assert.equal(session.sessionManager.getSessionId(), id)
  await worker.finish('complete', 'Done')
})

test('child guidance informs its coordinator and preserves scope and text', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const jobs = new Delegations(new StateStore(item.root))
  const job = await jobs.start(
    { task: 'Document the queue', context: '', kind: 'documents', writePaths: ['design.md'] },
    { session: 'guidance-parent', model: 'test/model' },
    async () => {},
  )
  const directory = delegationDirectory(jobs.store, job.request.id)
  await atomicJson(join(directory, 'status.json'), {
    ...job.state,
    status: 'running',
    pid: process.pid,
  })
  const parent = await live(item.root, 'task-coordinator')
  const child = await LiveWorker.start(item.root, {
    role: 'task-worker',
    model: 'test/model',
    task: 'Update queue.md',
    scope: ['design.md'],
    output: join(directory, 'child.json'),
    workspace: item.root,
    backend: 'pi',
    parentId: parent.info.id,
  })
  const notices: string[] = []
  const catalog = new WorkersCatalog(item.root, (_row, text) => {
    notices.push(text)
  })
  const text = 'Keep these words apart.\nUse capacity 120; do not change persistence.'
  await catalog.send(child.info.id, text)
  const updated = await jobs.get(job.request.id)
  assert.deepEqual(notices, [text])
  assert.equal((await child.mailbox.read()).messages[0]?.text, text)
  const controls = await readJson<TaskControls>(join(directory, 'controls.json'))
  assert.equal(controls?.messages.at(-1)?.text, text)
  assert.deepEqual(updated.request.writePaths, ['design.md'])
  await child.finish('complete', 'Done')
  await parent.finish('complete', 'Done')
})

test('new children retain their legacy coordinator group and guidance route', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const jobs = new Delegations(new StateStore(item.root))
  const job = await jobs.start(
    { task: 'Document the queue', context: '', kind: 'documents', writePaths: ['design.md'] },
    { session: 'legacy-parent', model: 'test/model' },
    async () => {},
  )
  const directory = delegationDirectory(jobs.store, job.request.id)
  await atomicJson(join(directory, 'status.json'), {
    ...job.state,
    status: 'running',
    pid: process.pid,
  })
  let index = 0
  const start = (role: string, workspace = item.root) =>
    LiveWorker.start(item.root, {
      role,
      model: 'test/model',
      task: 'Document the queue',
      scope: ['design.md'],
      output: join(directory, `child-${index++}.json`),
      workspace,
      backend: 'pi',
    })
  const author = await start('task-worker')
  await author.finish('complete', 'Ready for review')
  const differentCandidate = await start('task-worker', join(item.root, 'other-candidate'))
  await differentCandidate.finish('complete', 'Different candidate')
  const reviewer = await start('reviewer')
  const catalog = new WorkersCatalog(item.root)

  for (let iteration = 0; iteration < 2; iteration++) {
    const tree = workerTree(await catalog.list(), true)
    assert.deepEqual(
      tree.map(({ row, depth, context }) => [row.id, depth, context]),
      [
        [`task:${job.request.id}`, 0, false],
        [author.info.id, 1, true],
        [reviewer.info.id, 2, false],
      ],
    )
    assert.equal(tree[2]?.row.inferredRelationship, true)
  }

  const text = 'Verify recovery without adding writes.'
  await catalog.send(reviewer.info.id, text)
  assert.equal((await reviewer.mailbox.read()).messages[0]?.text, text)
  const controls = await readJson<TaskControls>(join(directory, 'controls.json'))
  assert.equal(controls?.messages.at(-1)?.text, text)
  const info = await readJson<{ parentId?: string }>(join(reviewer.directory, 'info.json'))
  assert.equal(info?.parentId, undefined, 'Display reconstruction must not rewrite worker metadata')
  await reviewer.finish('complete', 'Reviewed')
})

test('Escape leaves the guidance composer while delivery is pending', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const worker = await live(item.root)
  const rows = await new WorkersCatalog(item.root).list()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let closed = false
  const view = new WorkersView(
    {
      list: async () => rows,
      conversation: async () => ({ entries: [], truncated: false }),
      warnings: [],
      send: async () => {
        await pending
        return 'Guidance queued.'
      },
    },
    plainTheme,
    () => 24,
    () => {},
    () => {
      closed = true
    },
    false,
    false,
  )
  t.after(() => view.dispose())
  await view.refresh()
  view.handleInput('\r')
  view.handleInput('g')
  view.input.setValue('Please check recovery.')
  view.handleInput('\r')
  assert.equal(view.notice, 'Sending guidance…')
  view.handleInput('\x1b')
  assert.equal(view.composing, false)
  view.handleInput('\x0f')
  assert.equal(closed, true)
  release()
  await delay(10)
  await worker.finish('complete', 'Done')
})

test('legacy coordinator assignments and revisions display their message without envelopes', () => {
  const entries = [
    { task: 'Prepare deployment notes.', taskScope: {}, kind: 'documents' },
    { taskControlRevision: 2, taskUpdate: 'Cover disaster recovery.', immutableWriteScope: [] },
  ].map((payload) => ({ at: '', role: 'user', text: JSON.stringify(payload) }))
  const turns = transcriptTurns(entries)
  assert.deepEqual(
    turns.map((turn) => turn.blocks[0]),
    [
      { kind: 'prose', text: 'Prepare deployment notes.' },
      { kind: 'prose', text: 'Cover disaster recovery.' },
    ],
  )
})
