// Host-run integration check `native-board-disposable-cli`. It drives the released tldraw-sync
// CLI named by PI_WHITEBOARD_BIN against one disposable daemon: a temporary realpath directory
// holds its HOME, TMPDIR, BOARD_DATA_DIR and project, with no-op `open` and `xdg-open` first on
// PATH. It never reads or writes another board, and stops only the daemon it started.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@earendil-works/pi-ai'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { invariant } from '../src/invariant.ts'
import { BoardCommandFailed, object, openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { editReceipt, editRequest, nativeScene } from '../src/whiteboard-native.ts'
import { parseLink, parsePoll, type BoardLink } from '../src/whiteboard-protocol.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'
import { ManualClock } from './whiteboard-support.ts'

const execute = promisify(execFile)
const bin = process.env.PI_WHITEBOARD_BIN

if (!bin || !isAbsolute(bin)) {
  throw new Error('Set PI_WHITEBOARD_BIN to an expendable copy of the released tldraw-sync CLI')
}

// A short base keeps daemon socket paths under HOME and TMPDIR within the macOS 104-byte Unix
// socket path limit; the per-user macOS TMPDIR alone takes about 50 bytes.
const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
const scratch = await realpath(await mkdtemp(join(base, 'wb-')))
const shims = join(scratch, 'bin')
const project = join(scratch, 'project')
const agent = join(scratch, 'agent')
const directories = ['home', 'tmp', 'data', 'bin', 'project', 'agent']
await Promise.all(directories.map((name) => mkdir(join(scratch, name), { mode: 0o700 })))

for (const name of ['open', 'xdg-open']) {
  await writeFile(join(shims, name), '#!/bin/sh\nexit 0\n')
  await chmod(join(shims, name), 0o700)
}

// Every CLI process pih starts inherits this environment, so it can only reach this daemon.
Object.assign(process.env, {
  HOME: join(scratch, 'home'),
  TMPDIR: join(scratch, 'tmp'),
  BOARD_DATA_DIR: join(scratch, 'data'),
  PATH: shims + ':' + process.env.PATH,
})
assert.equal(tmpdir(), join(scratch, 'tmp'))
await execute('git', ['init', '-q', project])

// The released CLI requires a port from 1 to 65535, so the operating system picks a free loopback
// port and the probe releases it before the daemon binds it.
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.ok(address !== null && typeof address === 'object', 'The probe has a TCP address')
  assert.ok(Number.isInteger(address.port) && address.port >= 1 && address.port <= 65535)
  return address.port
}

async function daemon(command: 'start' | 'stop') {
  const args =
    command === 'start' ? ['start', '--port', String(await freePort()), '--no-open'] : ['stop']
  const options = { cwd: project, timeout: 60000, encoding: 'utf8' as const }

  // The disposable daemon holds no board yet, so its start and stop output carries no content.
  // A bounded excerpt names the cause of a failure.
  const stdout = await execute(bin!, [...args, '--json'], options).then(
    (result) => result.stdout,
    (error: unknown) => {
      const failure = object(error) ? error : {}
      const output = [failure.stdout, failure.stderr].filter((part) => typeof part === 'string')
      throw new Error(
        `tldraw-sync ${command} failed with exit ${String(failure.code)}: ` +
          output.join('\n').trim().slice(0, 2000),
      )
    },
  )
  const reply: unknown = JSON.parse(stdout)
  assert.ok(object(reply) && reply.status === 'success', `tldraw-sync ${command} succeeded`)
}

const signal = AbortSignal.timeout(180000)
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))

function records(scene: Record<string, unknown>) {
  const value = scene.records
  assert.ok(object(value) || Array.isArray(value), 'The scene artifact lists records')
  return (Array.isArray(value) ? value : Object.values(value)).filter(object)
}

function hash(scene: Record<string, unknown>, id: string) {
  const hashes = scene.hashes
  assert.ok(object(hashes), 'The scene artifact maps record ids to hashes')
  const value = hashes[id]
  assert.ok(typeof value === 'string' && value, `The scene artifact hashes ${id}`)
  return value
}

// The disposable record the board's own server tests add.
function firstShape(parentId: unknown) {
  return {
    id: 'shape:new-first',
    typeName: 'shape',
    type: 'draw',
    x: 100,
    y: 100,
    rotation: 0,
    index: 'a1',
    parentId,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      segments: [
        {
          type: 'free',
          points: [
            { x: 0, y: 0, z: 0.5 },
            { x: 10, y: 2, z: 0.5 },
          ],
        },
      ],
      isComplete: true,
      isClosed: false,
      isPen: true,
      scale: 1,
    },
  }
}

// One native board through the endpoint and the exact reply checks the tool uses.
async function nativeJourney() {
  const owner = 'native-live-a'
  const endpoint = await openBoardEndpoint(project, owner)
  const link = async () =>
    parseLink(await endpoint.run('link', ['--native'], signal), owner, endpoint.binding, 'native')
  const board = (await link()).link
  assert.deepEqual((await link()).link, board, 'A native relink reopens the same board')
  assert.equal(parsePoll(await endpoint.run('poll', [], signal), board).mode, 'native')

  const read = async () => {
    const reply = nativeScene(await endpoint.run('scene', [], signal), board)
    const scene: unknown = JSON.parse(await readFile(reply.scene_path, 'utf8'))
    assert.ok(object(scene) && scene.session === board.session, 'The artifact names this board')
    assert.equal(scene.base_sequence, reply.base_sequence)
    assert.equal(records(scene).length, reply.records_count)
    return { reply, scene }
  }

  const edit = async (name: string, value: unknown) => {
    const path = join(project, name)
    await writeFile(path, JSON.stringify(value))
    const request = editRequest(bytes(value))
    return editReceipt(await endpoint.run('edit', ['--file', path], signal), board, request)
  }

  const empty = await read()
  const page = records(empty.scene).find((record) => record.typeName === 'page')
  assert.ok(page, 'A new board has a page')
  const addition = {
    base_sequence: empty.reply.base_sequence,
    adds: [firstShape(page.id)],
    updates: [],
    deletes: [],
  }

  // The released CLI requires all three arrays, as pih does: an omitted one writes nothing.
  const partial = join(project, 'partial.json')
  const { deletes: _omitted, ...incomplete } = addition
  assert.throws(() => editRequest(bytes(incomplete)), /must be arrays/)
  await writeFile(partial, JSON.stringify(incomplete))
  await assert.rejects(endpoint.run('edit', ['--file', partial], signal), (error: Error) => {
    assert.ok(error instanceof BoardCommandFailed && error.settled)
    assert.match(error.message, /Whiteboard edit rejected\./)
    return true
  })
  assert.equal((await read()).reply.base_sequence, empty.reply.base_sequence, 'Nothing written')
  const written = await edit('add.json', addition)
  assert.equal(written.code, 'edit_written')
  assert.equal(written.minted.length, 1)
  const id = written.minted[0]!.id
  assert.ok(id.startsWith('shape:') && id !== 'shape:new-first')

  // An identical file after an uncertain reply replays; it never applies twice.
  const replayed = await edit('add.json', addition)
  assert.deepEqual(
    [replayed.code, replayed.sequence, replayed.minted],
    ['edit_replayed', written.sequence, written.minted],
  )

  const added = await read()
  assert.ok(added.reply.base_sequence > empty.reply.base_sequence)
  const shape = records(added.scene).find((record) => record.id === id)
  assert.ok(shape && shape.x === 100, 'The minted shape is on the board')
  const moved = {
    base_sequence: added.reply.base_sequence,
    adds: [],
    updates: [{ record: { ...shape, x: 160 }, base_hash: hash(added.scene, id) }],
    deletes: [],
  }
  const update = await edit('move.json', moved)
  assert.deepEqual([update.code, update.minted], ['edit_written', []])
  const after = await read()
  const kept = records(after.scene).find((record) => record.id === id)
  assert.ok(kept && kept.x === 160, 'The original shape id was edited in place')

  // A different edit on a stale base is a conflict: settled, never rebased or retried.
  const stale = {
    base_sequence: added.reply.base_sequence,
    adds: [],
    updates: [{ record: { ...shape, x: 220 }, base_hash: hash(added.scene, id) }],
    deletes: [],
  }
  await assert.rejects(edit('stale.json', stale), (error: Error) => {
    assert.ok(error instanceof BoardCommandFailed && error.settled)
    assert.match(error.message, /conflicts with the board\. Read the scene again/)
    return true
  })
  const unchanged = records((await read()).scene).find((record) => record.id === id)
  assert.equal(unchanged?.x, 160, 'A conflict wrote nothing')
  return { board, minted: id }
}

// A legacy board stays legacy: relinks keep its binding byte for byte and native is refused.
async function legacyJourney() {
  const owner = 'legacy-live-b'
  const endpoint = await openBoardEndpoint(project, owner)
  const link = async () =>
    parseLink(await endpoint.run('link', [], signal), owner, endpoint.binding, 'legacy')
  const board = (await link()).link
  const binding = await readFile(endpoint.binding)
  assert.deepEqual((await link()).link, board, 'A legacy relink reopens the same board')
  assert.ok(binding.equals(await readFile(endpoint.binding)), 'The binding is unchanged')

  await assert.rejects(endpoint.run('link', ['--native'], signal), /Whiteboard link failed/)
  assert.ok(
    binding.equals(await readFile(endpoint.binding)),
    'A refused native link relinks nothing',
  )
  assert.deepEqual((await link()).link, board, 'The legacy board is still the same board')
  assert.equal(parsePoll(await endpoint.run('poll', [], signal), board).mode, 'legacy')
  await assert.rejects(endpoint.run('scene', [], signal), /Whiteboard scene failed/)

  const file = join(project, 'legacy-edit.json')
  const value = { base_sequence: 1, adds: [firstShape('page:page')], updates: [], deletes: [] }
  editRequest(bytes(value))
  await writeFile(file, JSON.stringify(value))
  await assert.rejects(endpoint.run('edit', ['--file', file], signal), (error: Error) => {
    assert.ok(error instanceof BoardCommandFailed && error.settled, 'A legacy board wrote nothing')
    assert.match(error.message, /not native/)
    return true
  })
  return board
}

function text(message: Context['messages'][number] | undefined) {
  const content = message?.content
  return typeof content === 'string'
    ? content
    : (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

// The real tool path in a Pi session with a scripted host. The plan for a step may depend on
// the previous result, so it is a function of the results so far.
async function sessionJourney(
  start: string,
  plan: (results: string[]) => Record<string, string> | undefined,
) {
  invariant(start.startsWith('/start_whiteboard'), 'A journey starts a whiteboard')
  const results: { isError: boolean; text: string }[] = []
  const { session, runtime } = await captureSession(
    project,
    agent,
    [(pi) => registerWhiteboard(pi, openBoardEndpoint, new ManualClock())],
    async (context) => {
      const last = context.messages.at(-1)

      if (last?.role === 'toolResult') {
        results.push({ isError: last.isError, text: text(last) })
      }

      // Only the request after linking uses the board.
      const asked = context.messages.some((m) => m.role === 'user' && text(m) === 'Use the board')
      const action = asked ? plan(results.map((r) => r.text)) : undefined
      const call = { type: 'toolCall' as const, id: String(results.length), name: 'whiteboard' }
      return action ? [{ ...call, arguments: action }] : [{ type: 'text', text: 'Done.' }]
    },
  )
  const errors: string[] = []
  const ui = {
    notify: (message: string, type?: string) => type === 'error' && errors.push(message),
  } as unknown as ExtensionUIContext

  try {
    await session.bindExtensions({ mode: 'tui', uiContext: ui })
    await session.prompt('Before the board')
    await session.prompt(start)
    assert.deepEqual(errors, [], `${start} linked`)
    await session.prompt('Use the board')
    await session.waitForIdle()
    return { results, errors, session }
  } finally {
    await session.dispose()
    await runtime.settleCredentialWrites()
  }
}

// The host's edit file, written once from the scene it read in the session.
function sessionEdit(sceneResult: string) {
  const scene = JSON.parse(sceneResult) as { base_sequence: number; scene_path: string }
  const artifact: unknown = JSON.parse(readFileSync(scene.scene_path, 'utf8'))
  assert.ok(object(artifact))
  const page = records(artifact).find((record) => record.typeName === 'page')
  const value = {
    base_sequence: scene.base_sequence,
    adds: [firstShape(page?.id)],
    updates: [],
    deletes: [],
  }
  writeFileSync(join(project, 'session-edit.json'), JSON.stringify(value), { flag: 'wx' })
  return { action: 'edit', file: 'session-edit.json' }
}

async function nativeSession() {
  let edit: Record<string, string> | undefined
  const { results } = await sessionJourney('/start_whiteboard', (done) => {
    if (done.length === 3) {
      edit = sessionEdit(done[2]!)
    }

    // The fifth step resends the identical file, as after an uncertain reply.
    const steps: (Record<string, string> | undefined)[] = [
      { action: 'status' },
      { action: 'snapshot' },
      { action: 'scene' },
      edit,
      edit,
    ]
    return steps[done.length]
  })
  assert.deepEqual(
    results.map((r) => r.isError),
    [false, true, false, false, false],
  )
  assert.equal(JSON.parse(results[0]!.text).mode, 'native')
  assert.match(results[1]!.text, /native board: use scene and edit/)
  const [first, retry] = [JSON.parse(results[3]!.text), JSON.parse(results[4]!.text)]
  assert.deepEqual([first.code, retry.code], ['edit_written', 'edit_replayed'])
  assert.deepEqual(retry.minted, first.minted)
}

async function legacySession() {
  const steps: Record<string, string>[] = [
    { action: 'status' },
    { action: 'scene' },
    { action: 'edit', file: 'x.json' },
  ]
  const { results } = await sessionJourney('/start_whiteboard legacy', (done) => steps[done.length])
  assert.deepEqual(
    results.map((r) => r.isError),
    [false, true, true],
  )
  assert.equal(JSON.parse(results[0]!.text).mode, 'legacy')
  assert.match(results[1]!.text, /legacy board: use snapshot, preview and publish/)
}

let started = false

try {
  await daemon('start')
  started = true
  const native = await nativeJourney()
  const legacy: BoardLink = await legacyJourney()
  assert.notEqual(native.board.session, legacy.session, 'Each owner has its own board')
  await nativeSession()
  await legacySession()
  console.log(
    `Disposable daemon: native board ${native.board.session} wrote, replayed, edited in place ` +
      `and refused a stale edit of ${native.minted}; legacy board ${legacy.session} kept its ` +
      'binding and refused native link, scene and edit; pih sessions linked each mode.',
  )
} finally {
  if (started) {
    await daemon('stop')
  }

  await rm(scratch, { recursive: true, force: true })
}
