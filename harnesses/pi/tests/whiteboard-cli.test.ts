import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { parseLink, parsePoll } from '../src/whiteboard-protocol.ts'

const cli = `#!/usr/bin/env node
const fs = require('node:fs')
const [command, ...args] = process.argv.slice(2)
const field = (name) => args[args.indexOf(name) + 1]
const file = field('--out')
const reply = { status: 'success', session: 'board', owner: 'host' }
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
  Object.assign(reply, {sketch_hash:'hash', agent_revision:0, events:[], token:'private-marker'})
} else if (command === 'whiteboard-snapshot') {
  reply.details = { scoped_token: 'private-marker' }
} else if (field('--file') === 'large') {
  reply.padding = 'x'.repeat(1024 * 1024)
} else if (field('--file') === 'closed') {
  console.error('private-marker')
  console.log(JSON.stringify({status:'failure', code:'stage_closed', message:'private-marker'}))
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
  const linked = parseLink(await endpoint.run('link', [], signal), 'host', endpoint.binding)
  assert.equal(linked.draw, 'http://lan/draw')
  execFileSync('git', ['check-ignore', '--', endpoint.binding], { cwd: root })
  const status = await endpoint.run('poll', [], signal)
  assert.doesNotMatch(JSON.stringify(parsePoll(status, linked.link)), /private-marker/)

  for (const identity of [{ owner: 'other' }, { session: 'other' }]) {
    assert.throws(() => parsePoll({ ...status, ...identity }, linked.link), /mismatched/)
  }

  const args = ['--layer', 'ideas', '--file', 'with space; echo not-a-shell']
  const published = await endpoint.run('publish', args, signal)
  assert.deepEqual(published.args, ['--binding', endpoint.binding, ...args, '--json'])

  for (const file of ['large', 'closed']) {
    await assert.rejects(endpoint.run('publish', ['--file', file], signal), (error: Error) => {
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /private-marker|with space/)
      assert.match(error.message, /Whiteboard publish failed/)

      if (file === 'closed') {
        assert.match(error.message, /Reopen the Mac stage/)
      }

      return true
    })
  }

  await assert.rejects(endpoint.run('snapshot', ['--layer', 'ideas'], signal), /snapshot failed/)
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
