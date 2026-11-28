import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BoardUpgradeRequired, boardProtocol, openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { boardArguments, parseLink, parsePoll } from '../src/whiteboard-protocol.ts'

const cli = `#!/usr/bin/env node
const fs = require('node:fs')
const [command, ...args] = process.argv.slice(2)
const field = (name) => args[args.indexOf(name) + 1]
const file = field('--out')
const reply = { status: 'success', session: 'board', owner: 'host' }
// Like tldraw-sync: the CLI speaks one protocol, and the daemon may still be running another.
const number = (name, otherwise) =>
  fs.existsSync(name) ? Number(fs.readFileSync(name, 'utf8')) : otherwise
const supported = number('cli-protocol', 4)
const daemon = number('daemon-protocol', supported)
if (command === 'status') {
  if (fs.existsSync('status-broken')) process.exit(1)
  if (daemon === 0) {
    console.log(JSON.stringify({ status: 'failure', code: 'not_running', token: 'private-marker' }))
    process.exit(2)
  }
  console.log(JSON.stringify({ status: 'success', code: 'running', protocol: daemon }))
  process.exit(0)
}
if (['whiteboard-link', 'whiteboard-poll'].includes(command)) {
  if (field('--protocol') !== String(supported) || daemon !== supported) {
    console.log(JSON.stringify({ status: 'failure', code: 'upgrade_required',
      message: 'Whiteboard protocol ' + supported + ' is required.' }))
    process.exit(1)
  }
  if (!fs.existsSync('silent-cli')) reply.protocol = supported
}
if (command === 'whiteboard-link') {
  fs.writeFileSync(file, 'private-binding-marker', { mode: 0o600 })
  Object.assign(reply, { binding_file: file,
    draw_url: 'http://lan/draw', stage_url: 'http://lan/stage' })
} else if (fs.readFileSync(field('--binding'), 'utf8') !== 'private-binding-marker') {
  process.exit(2)
} else if (command === 'whiteboard-poll') {
  if (fs.existsSync('slow-poll')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)
  }
  if (fs.existsSync('padded')) reply.padding = ' '.repeat(Number(fs.readFileSync('padded', 'utf8')))
  const events = fs.existsSync('events.json') ? JSON.parse(fs.readFileSync('events.json')) : []
  Object.assign(reply, {sketch_hash:'hash', agent_revision:0, events, token:'private-marker'})
} else if (command === 'whiteboard-snapshot') {
  reply.details = { scoped_token: 'private-marker' }
} else if (field('--file') === 'large') {
  reply.padding = 'x'.repeat(1024 * 1024)
} else if (field('--file') === 'closed') {
  console.error('private-marker')
  console.log(JSON.stringify({status:'failure', code:'stage_closed', message:'private-marker'}))
  process.exit(2)
} else if (field('--file') === 'conflict') {
  const conflict = { status: 'failure', code: 'revision_conflict', message: 'private-marker' }
  console.log(JSON.stringify(conflict))
  process.exit(2)
} else {
  reply.args = args
}
console.log(JSON.stringify(reply))
`

test('CLI argv, binding privacy, flat envelopes and output cap', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-cli-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const subdir = join(root, 'sub')
  await mkdir(subdir)
  const bin = join(root, 'cli fixture.cjs')
  await writeFile(bin, cli, { mode: 0o700 })
  const override = process.env.PI_WHITEBOARD_BIN
  t.after(() => {
    if (override === undefined) {
      delete process.env.PI_WHITEBOARD_BIN
    } else {
      process.env.PI_WHITEBOARD_BIN = override
    }
  })
  process.env.PI_WHITEBOARD_BIN = bin
  const endpoint = await openBoardEndpoint(subdir, 'host')
  const signal = new AbortController().signal
  assert.equal(endpoint.binding, join(root, '.pi/traces/harness/whiteboards/host.json'))
  const silent = join(subdir, 'silent-cli')
  await writeFile(silent, '')
  await assert.rejects(endpoint.run('link', [], signal), /protocol mismatch: pih requests 4/)
  await rm(silent)
  const linked = parseLink(
    await endpoint.run('link', [], signal),
    'host',
    endpoint.binding,
    'legacy',
  )
  assert.equal(linked.draw, 'http://lan/draw')
  execFileSync('git', ['check-ignore', '--', endpoint.binding], { cwd: root })
  const status = await endpoint.run('poll', [], signal)
  assert.doesNotMatch(JSON.stringify(parsePoll(status, linked.link)), /private-marker/)

  const text = ' \t{"credential": "🦦"}\r\n感想: \n '
  const event = {
    id: 'event',
    request_id: '00000000-0000-4000-8000-000000000001',
    text,
    kind: 'sketch_notify',
    sketch_hash: 'hash',
    created_at_ms: 123,
    state: 'queued',
  }
  const chat = {
    ...event,
    id: 'chat',
    request_id: '00000000-0000-4000-8000-000000000002',
    include_sketch: false,
  }
  const eventsPath = join(subdir, 'events.json')
  await writeFile(eventsPath, JSON.stringify([{ ...event, token: 'private-marker' }, chat]))
  const polled = parsePoll(await endpoint.run('poll', [], signal), linked.link)
  assert.deepEqual(polled.events, [{ ...event, include_sketch: true }, chat])
  await rm(eventsPath)

  // The answer reaches the CLI process as one exact argv value.
  const answer = ' I read it privately. 🦦\r\n\t"--binding" stays text; Café '
  const ack = { action: 'ack', event: 'chat', state: 'updated', message: answer } as const
  const answered = await endpoint.run('ack', boardArguments(ack), signal)
  assert.deepEqual(answered.args, [
    '--binding',
    endpoint.binding,
    '--event',
    'chat',
    '--state',
    'updated',
    '--message',
    answer,
    '--json',
  ])

  for (const identity of [{ owner: 'other' }, { session: 'other' }]) {
    assert.throws(() => parsePoll({ ...status, ...identity }, linked.link), /mismatched/)
  }

  const padding = join(subdir, 'padded')
  await writeFile(padding, String(1024 * 1024))
  assert.deepEqual(parsePoll(await endpoint.run('poll', [], signal), linked.link).events, [])
  await writeFile(padding, String(2 * 1024 * 1024))
  await assert.rejects(endpoint.run('poll', [], signal), /poll failed/)
  await rm(padding)
  const args = ['--file', 'with space; echo not-a-shell']
  const published = await endpoint.run('publish', args, signal)
  assert.deepEqual(published.args, ['--binding', endpoint.binding, ...args, '--json'])

  for (const file of ['large', 'closed', 'conflict']) {
    await assert.rejects(endpoint.run('publish', ['--file', file], signal), (error: Error) => {
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /private-marker|with space/)
      assert.match(error.message, /Whiteboard publish failed/)

      if (file === 'closed') {
        assert.match(error.message, /Reopen the Mac stage/)
      }

      // Publish owns only the agent print; its revision guards that layer, not a retired canvas.
      if (file === 'conflict') {
        assert.match(error.message, /The agent print changed\. Take a fresh snapshot\./)
      }

      return true
    })
  }

  await assert.rejects(endpoint.run('snapshot', [], signal), /snapshot failed/)
  await writeFile(join(subdir, 'slow-poll'), '')
  const deadline = AbortSignal.timeout(6000)
  await assert.rejects(endpoint.run('poll', [], deadline), /poll failed/)
  assert.equal(deadline.aborted, false, 'The CLI poll must own its shorter timeout')
  await chmod(endpoint.binding, 0o644)
  await assert.rejects(endpoint.run('poll', [], signal), /0600/)
  await rm(endpoint.binding)
  await symlink(bin, endpoint.binding)
  await assert.rejects(endpoint.run('link', [], signal), /Unsafe/)
  await assert.rejects(openBoardEndpoint(root, '../unscoped'), /session owner/)
  process.env.PI_WHITEBOARD_BIN = join(root, 'absent')
  await assert.rejects(openBoardEndpoint(root, 'host'), /Install tldraw-sync on PATH/)
})

// Escaped bug: tldraw-sync shipped protocol 3 while the installed launcher asked for 2 and a
// daemon started before the upgrade still served 2. The launcher said only "upgrade to protocol
// 2 and restart", which named none of the three and could not be acted on.
test('a protocol mismatch names the launcher, CLI and daemon versions', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-versions-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const bin = join(root, 'cli.cjs')
  await writeFile(bin, cli, { mode: 0o700 })
  const override = process.env.PI_WHITEBOARD_BIN
  t.after(() => {
    if (override === undefined) {
      delete process.env.PI_WHITEBOARD_BIN
    } else {
      process.env.PI_WHITEBOARD_BIN = override
    }
  })
  process.env.PI_WHITEBOARD_BIN = bin
  const signal = new AbortController().signal
  const set = async (name: string, value?: number) =>
    value === undefined
      ? rm(join(root, name), { force: true })
      : writeFile(join(root, name), String(value))

  async function mismatch(requested: number, supported: number, daemon: number) {
    await set('cli-protocol', supported)
    await set('daemon-protocol', daemon)
    const endpoint = await openBoardEndpoint(root, 'host', requested)
    const errors: unknown[] = []

    for (const command of ['link', 'poll'] as const) {
      if (command === 'poll') {
        await writeFile(endpoint.binding, 'private-binding-marker', { mode: 0o600 })
      }

      errors.push(await endpoint.run(command, [], signal).catch((error) => error))
      await rm(endpoint.binding, { force: true })
    }

    assert.ok(
      errors[0] instanceof BoardUpgradeRequired && errors[1] instanceof BoardUpgradeRequired,
    )
    assert.equal(errors[0].message, errors[1].message)
    assert.doesNotMatch(errors[0].message + errors[0].stack, /private-marker/)
    return errors[0]
  }

  // The observed failure: launcher 2, CLI 3, daemon 2.
  const observed = await mismatch(2, 3, 2)
  assert.deepEqual(observed.versions, { requested: 2, cli: 3, daemon: 2 })
  assert.match(
    observed.message,
    /pih requests 2, the tldraw-sync CLI supports 3, the daemon reports 2\. Update pih/,
  )

  // The same board once the launcher is current: only the daemon is behind.
  const stale = await mismatch(boardProtocol, 4, 3)
  assert.deepEqual(stale.versions, { requested: 4, cli: 4, daemon: 3 })
  assert.match(stale.message, /CLI supports 4, the daemon reports 3\. .*tldraw-sync stop/)

  const old = await mismatch(boardProtocol, 3, 3)
  assert.deepEqual(old.versions, { requested: 4, cli: 3, daemon: 3 })
  assert.match(old.message, /CLI supports 3, the daemon reports 3\. Upgrade tldraw-sync/)

  const stopped = await mismatch(2, 3, 0)
  assert.deepEqual(stopped.versions, { requested: 2, cli: 3, daemon: 'stopped' })
  assert.match(stopped.message, /the daemon is not running\. Update pih/)

  // A status that cannot be read is reported as unknown, never guessed.
  await writeFile(join(root, 'status-broken'), '')
  const unknown = await mismatch(2, 3, 2)
  assert.deepEqual(unknown.versions, { requested: 2, cli: 3, daemon: undefined })
  assert.match(unknown.message, /the daemon reports an unknown version/)
  await rm(join(root, 'status-broken'))

  await set('cli-protocol', 4)
  await set('daemon-protocol', 4)
  const endpoint = await openBoardEndpoint(root, 'host')
  assert.equal((await endpoint.run('link', [], signal)).protocol, 4)
})
