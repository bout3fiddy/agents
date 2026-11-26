import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PaperHost } from './host.ts'
import { limits } from './protocol.ts'

const fake = fileURLToPath(new URL('./fake-desktop.mjs', import.meta.url))
const styled = { text: 'Hello', foreground: '#112233', background: '#eeeeee', sizePx: 24 }

function fixture(t: TestContext, scenario = 'ok') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'paper-api-')))
  const root = join(base, 'private')
  const worktree = join(base, 'repo')
  const home = join(base, 'home')
  const log = join(base, 'wire.jsonl')

  for (const path of [root, worktree, home, join(home, '.claude')]) {
    mkdirSync(path, { mode: 0o700 })
  }

  const settings = join(home, '.claude', 'settings.json')
  writeFileSync(settings, 'untouched')
  const owner = { sessionId: 's1', taskId: 't1', worktree }
  const input = {
    purpose: 'frontend-design' as const,
    owner,
    target: { fileId: 'file-A', pageId: 'page-A', nodeIds: ['source'] },
    ttlMs: limits.lifetimeMs,
    draftTargetingVerified: true,
  }
  let child: ChildProcess
  const host = new PaperHost(root, () => {
    const cli = spawn(process.execPath, [fake, log, scenario], {
      cwd: base,
      env: { HOME: home },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    child = cli
    return cli
  })
  t.after(async () => {
    const status = host.status(owner)

    if (status.outcome === 'ok') {
      await host.detach(owner, status.attachmentId)
    }

    assert.deepEqual(readdirSync(worktree), [])
    assert.deepEqual(readdirSync(home), ['.claude'])
    assert.deepEqual(readdirSync(join(home, '.claude')), ['settings.json'])
    assert.equal(readFileSync(settings, 'utf8'), 'untouched')
    rmSync(base, { recursive: true })
  })
  const packets = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
  const calls = () =>
    packets()
      .filter((packet) => packet.method === 'tools/call')
      .map((packet) => packet.params)
  const attach = async () => {
    const result = await host.attach(input)
    assert.equal(result.outcome, 'ok')
    const id = result.attachmentId
    return {
      result,
      id,
      call: (name: string, args: unknown = {}) => host.call(owner, id, name, args),
    }
  }
  return {
    root,
    worktree,
    home,
    log,
    owner,
    input,
    host,
    attach,
    calls,
    packets,
    child: () => child,
  }
}

test('workspace, non-design roles and stale dispatches have no authority', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.host.tools(f.owner, 'absent'), [])
  assert.deepEqual(await f.host.attach({ ...f.input, purpose: 'build' as never }), {
    outcome: 'denied',
  })
  const bad = new PaperHost(f.worktree, () => assert.fail('must not launch'))
  assert.deepEqual(await bad.attach(f.input), { outcome: 'storage' })
  const checkout = join(f.home, 'another-checkout')
  mkdirSync(checkout)
  mkdirSync(join(checkout, '.git'))
  const repoPrivate = join(checkout, 'private')
  mkdirSync(repoPrivate, { mode: 0o700 })
  const foreign = new PaperHost(repoPrivate, () => assert.fail('state must not enter any repo'))
  const refused = await foreign.attach(f.input)
  rmSync(checkout, { recursive: true })
  assert.deepEqual(refused, { outcome: 'storage' })
  const filesystemRoot = { ...f.owner, worktree: '/' }
  assert.deepEqual(await f.host.attach({ ...f.input, owner: filesystemRoot }), {
    outcome: 'storage',
  })
  assert.deepEqual(f.packets(), [])
  const { id } = await f.attach()
  const count = f.packets().length
  const status = f.host.status(f.owner)
  assert.equal(status.outcome, 'ok')
  assert.deepEqual(status.target, f.input.target)
  status.target.nodeIds.push('not-pinned')
  assert.equal(
    (await f.host.call(f.owner, id, 'paper_node', { nodeId: 'not-pinned' })).outcome,
    'denied',
  )
  const advisor = f.host.bind(f.owner, id, 'read')
  assert.equal(advisor.tools().length, 5)
  assert.deepEqual(await advisor.call('paper_new_draft', {}), { outcome: 'denied' })

  for (const changed of [{ taskId: 'other' }, { sessionId: 'other' }, { worktree: f.root }]) {
    const other = { ...f.owner, ...changed }
    assert.deepEqual(f.host.tools(other, id), [])
    assert.equal((await f.host.call(other, id, 'paper_page', {})).outcome, 'denied')
    assert.equal((await f.host.detach(other, id)).outcome, 'denied')
  }

  assert.equal(f.packets().length, count)
  assert.equal((await f.host.detach(f.owner, id)).outcome, 'ok')
  await f.attach()
  assert.deepEqual(advisor.tools(), [])
  assert.deepEqual(await advisor.call('paper_page', {}), { outcome: 'denied' })
  assert.equal((await f.host.call(f.owner, id, 'paper_page', {})).outcome, 'denied')
})

test('strict tools pin the wire, filter selection and capture private snapshots', async (t) => {
  const f = fixture(t)
  const { id, result, call } = await f.attach()
  const descriptors = f.host.tools(f.owner, id)
  assert.equal(descriptors.length, 7)

  for (const { inputSchema } of descriptors) {
    assert.equal(inputSchema.additionalProperties, false)
    assert.deepEqual(inputSchema.required, Object.keys(inputSchema.properties))
    assert.ok(!inputSchema.required.includes('fileId'))
  }

  assert.equal((await call('paper_children', { nodeId: 'source' })).outcome, 'ok')
  const selected = await call('paper_selection')
  assert.equal(selected.outcome, 'ok')
  assert.deepEqual(selected.value, {
    untrusted: true,
    content: [{ type: 'text', text: '["source"]' }],
  })
  const capture = await f.host.capture(f.owner, id, 'source')
  assert.equal(capture.outcome, 'ok')
  assert.deepEqual(
    f
      .packets()
      .slice(0, 3)
      .map((p) => p.method),
    ['initialize', 'notifications/initialized', 'tools/list'],
  )
  const args = (name: string, fields: object) => ({
    name,
    arguments: { ...fields, fileId: 'file-A' },
  })
  assert.deepEqual(f.calls(), [
    args('get_basic_info', { pageId: 'page-A' }),
    args('get_children', { nodeId: 'source' }),
    args('get_selection', {}),
    args('get_node_info', { nodeId: 'source' }),
    args('get_screenshot', { nodeId: 'source' }),
  ])
  await f.host.detach(f.owner, id)

  for (const ref of [result.snapshot, capture.value]) {
    const path = join(f.root, `${ref.id}.snapshot`)
    const bytes = readFileSync(path)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256)
    assert.equal(statSync(path).mode & 0o777, 0o400)
    const saved = JSON.parse(bytes.toString())
    assert.deepEqual(saved.owner, f.owner)
    assert.deepEqual(saved.target, f.input.target)
    assert.equal(saved.attachmentId, id)
    assert.equal(saved.untrusted, true)
  }
})

test('append fixed markup to a new board without target overrides', async (t) => {
  const f = fixture(t)
  const { call } = await f.attach()
  const created = await call('paper_new_draft')
  assert.equal(created.outcome, 'ok')
  const written = await call('paper_append', { boardId: 'new-1', ...styled })
  assert.equal(written.outcome, 'ok')
  const count = f.calls().length

  for (const [name, args] of [
    ['paper_append', { ...styled, boardId: 'source' }],
    ['paper_append', { ...styled, boardId: 'new-1', text: '</div><img src="https://other/">' }],
    ['paper_append', { ...styled, boardId: 'new-1', foreground: 'url(file:///private)' }],
    ['paper_append', { ...styled, boardId: 'new-1', mode: 'replace' }],
    ['paper_node', { nodeId: 'source', fileId: 'file-B' }],
    ['paper_children', { nodeId: 'other' }],
    ['write_html', { nodeId: 'source' }],
  ] as const) {
    assert.ok(['invalid', 'denied'].includes((await call(name, args)).outcome))
  }

  assert.equal(f.calls().length, count)
  const mutations = f.calls().filter((c) => ['create_artboard', 'write_html'].includes(c.name))
  assert.equal(mutations.length, 2)
  assert.match(mutations[0].arguments.name, /^pih-draft-/)
  assert.deepEqual(mutations[0].arguments, {
    fileId: 'file-A',
    pageId: 'page-A',
    name: mutations[0].arguments.name,
    styles: { width: '1024px', height: '768px' },
  })
  const html =
    '<div style="color:#112233;background-color:#eeeeee;font-size:24px;padding:16px">Hello</div>'
  assert.deepEqual(mutations[1], {
    name: 'write_html',
    arguments: {
      fileId: 'file-A',
      targetNodeId: 'new-1',
      mode: 'insert-children',
      html,
    },
  })
})

for (const scenario of ['no-proof', 'unsafe-write', 'host-read-only', 'unprobed']) {
  test(`read-only when targeting is unproven: ${scenario}`, async (t) => {
    const f = fixture(t, scenario)

    if (scenario === 'host-read-only') {
      f.input.draftTargetingVerified = false
    }

    const { call, id, result } = await f.attach()
    assert.equal(result.writable, false)
    assert.equal(f.host.tools(f.owner, id).length, 5)
    assert.equal((await call('paper_new_draft')).outcome, 'read_only')
    assert.deepEqual(
      f.calls().map((c) => c.name),
      ['get_basic_info'],
    )
  })
}

test('missing explicit read targeting fails before any document request', async (t) => {
  const f = fixture(t, 'missing-pin')
  assert.deepEqual(await f.host.attach(f.input), { outcome: 'unsupported' })
  assert.deepEqual(f.calls(), [])
  assert.deepEqual(readdirSync(f.root), [])
})

for (const scenario of ['wrong-file', 'recycled', 'moved']) {
  test(`conflicting target never yields contents or a write grant: ${scenario}`, async (t) => {
    const f = fixture(t, scenario)
    const { call } = await f.attach()

    if (scenario === 'moved') {
      assert.equal((await call('paper_new_draft')).outcome, 'ok')
    }

    const result =
      scenario === 'wrong-file'
        ? await call('paper_node', { nodeId: 'source' })
        : scenario === 'recycled'
          ? await call('paper_new_draft')
          : await call('paper_append', { boardId: 'new-1', ...styled })
    assert.deepEqual(result, { outcome: 'wrong_target' })
    assert.ok(!f.calls().some((c) => c.name === 'write_html'))
    assert.ok(!existsSync(join(f.root, 'desktop-writer.lock')))
  })
}

test('writer lease spans host processes; detach permits next writer', async (t) => {
  const f = fixture(t)
  const { id } = await f.attach()
  const contend = () => {
    const contender = spawnSync(process.execPath, [fake, f.log, 'contender'], {
      input: JSON.stringify({
        root: f.root,
        grant: { ...f.input, owner: { ...f.owner, taskId: 't2' } },
      }),
      timeout: 5000,
      encoding: 'utf8',
      env: { HOME: f.home },
    })
    assert.equal(contender.status, 0, contender.stderr)
    return contender.stdout
  }
  assert.equal(contend(), 'busy')
  assert.equal((await f.host.detach(f.owner, id)).outcome, 'ok')
  assert.equal(contend(), 'ok')
})

test('revoke during a live request rejects concurrent work and kills the CLI', async (t) => {
  const f = fixture(t, 'wait')
  const { call, id } = await f.attach()
  const waiting = once(f.child(), 'message')
  const pending = call('paper_node', { nodeId: 'source' })
  await waiting
  assert.deepEqual(await call('paper_new_draft'), { outcome: 'busy' })

  // Replay the order of competing calls on both sides of the revoke boundary.
  let seed = Number(process.env.PAPER_TEST_SEED ?? 17) >>> 0
  const operations = ['detach', 'read', 'draft', 'stale', 'foreign']
  let revoked = false

  for (let remaining = operations.length; remaining > 0; remaining--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const [operation] = operations.splice(seed % remaining, 1)

    if (operation === 'detach') {
      assert.equal((await f.host.detach(f.owner, id)).outcome, 'ok')
      revoked = true
    } else if (operation === 'read' || operation === 'draft') {
      const name = operation === 'read' ? 'paper_page' : 'paper_new_draft'
      assert.equal((await call(name)).outcome, revoked ? 'detached' : 'busy')
    } else {
      const owner = operation === 'foreign' ? { ...f.owner, taskId: 'other' } : f.owner
      const token = operation === 'stale' ? 'old' : id
      const result = await f.host.call(owner, token, 'paper_page', {})
      assert.equal(result.outcome, revoked ? 'detached' : 'denied')
    }
  }

  assert.deepEqual(
    f.calls().map((request) => request.name),
    ['get_basic_info', 'get_node_info'],
  )
  assert.deepEqual(await pending, { outcome: 'detached' })
  assert.ok(f.child().exitCode !== null || f.child().signalCode !== null)
  assert.deepEqual(f.host.tools(f.owner, id), [])
})

test('expiry invalidates the grant without worker traffic', async (t) => {
  const f = fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { id } = await f.attach()

  // A denied signal emits 'error'; EOF is also a valid exit path. Observe actual closure.
  const closed = new Promise<void>((resolve) => f.child().once('close', () => resolve()))
  t.mock.timers.tick(limits.lifetimeMs)
  assert.deepEqual(f.host.tools(f.owner, id), [])
  await closed
  await Promise.resolve()
  assert.ok(!existsSync(join(f.root, 'desktop-writer.lock')))
})

test('stalled request times out with no retry and releases the writer', async (t) => {
  const f = fixture(t, 'wait')
  const { call } = await f.attach()
  const waiting = once(f.child(), 'message')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = call('paper_node', { nodeId: 'source' })
  await waiting
  t.mock.timers.tick(limits.timeoutMs)
  assert.deepEqual(await pending, { outcome: 'timeout' })
  assert.ok(!existsSync(join(f.root, 'desktop-writer.lock')))
  assert.equal(f.calls().filter((packet) => packet.name === 'get_node_info').length, 1)
})

for (const [scenario, expected] of [
  ['bad-id', 'protocol'],
  ['big-frame', 'limit'],
  ['huge-image', 'limit'],
]) {
  test(`terminal ${scenario} is bounded and releases writer`, async (t) => {
    const f = fixture(t, scenario)
    const { call } = await f.attach()
    const tool = scenario === 'huge-image' ? 'paper_screenshot' : 'paper_node'
    assert.deepEqual(await call(tool, { nodeId: 'source' }), { outcome: expected })
    assert.ok(f.child().exitCode !== null || f.child().signalCode !== null)
    assert.ok(!existsSync(join(f.root, 'desktop-writer.lock')))
  })
}

test('wire budget includes handshake and refuses the first excess call before send', async (t) => {
  const f = fixture(t)
  const { call } = await f.attach()

  for (let i = 3; i < limits.calls; i++) {
    assert.equal((await call('paper_page')).outcome, 'ok')
  }

  assert.deepEqual(await call('paper_page'), { outcome: 'limit' })
  assert.equal(f.packets().filter((packet) => packet.id !== undefined).length, limits.calls)
})

test('repeated invalid requests terminate without Paper traffic', async (t) => {
  const f = fixture(t)
  const { call } = await f.attach()

  for (let i = 0; i < 7; i++) {
    assert.deepEqual(await call('paper_page', { extra: i }), { outcome: 'invalid' })
  }

  assert.deepEqual(await call('paper_page', { extra: 7 }), { outcome: 'limit' })
  assert.deepEqual(
    f.calls().map((c) => c.name),
    ['get_basic_info'],
  )
})
