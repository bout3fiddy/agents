// Opt-in only: this opens a real Mac stage and intentionally leaves its board and daemon intact.
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { boardProtocol, object, openBoardEndpoint } from '../src/whiteboard-cli.ts'
import {
  boardArguments,
  canvasSnapshot,
  parseLink,
  parsePoll,
  preview,
  publication,
} from '../src/whiteboard-protocol.ts'

const [project, owner, controlledScene, selection] = process.argv.slice(2)
const [control, option] = selection?.split('=') ?? []

if (
  !project ||
  !owner?.startsWith('whiteboard-smoke-') ||
  !controlledScene ||
  !control ||
  !option
) {
  throw new Error(
    'Supply a disposable project directory, a whiteboard-smoke- owner ID, a synthetic scene ' +
      'with at least two controls and control=option naming a non-resting option of one',
  )
}

const endpoint = await openBoardEndpoint(resolve(project), owner)
const signal = AbortSignal.timeout(120000)
const link = async () => parseLink(await endpoint.run('link', [], signal), owner, endpoint.binding)
const first = await link()
const reopened = await link()
assert.deepEqual(first.link, reopened.link)
const status = parsePoll(await endpoint.run('poll', [], signal), first.link)
const revision = async () =>
  parsePoll(await endpoint.run('poll', [], signal), first.link).agent_revision

// The snapshot describes its own capabilities in a readable artifact.
const snapshot = canvasSnapshot(await endpoint.run('snapshot', [], signal), first.link)
const { image_path, records_path, scene_path, capabilities_path } = snapshot
assert.ok(typeof image_path === 'string' && typeof records_path === 'string')
assert.ok(typeof scene_path === 'string' && typeof capabilities_path === 'string')
assert.equal(snapshot.base_revision, status.agent_revision, 'Expected an idle disposable canvas')
await Promise.all([access(image_path), access(records_path), access(scene_path)])
assert.ok((await readFile(capabilities_path, 'utf8')).length, 'Readable capabilities artifact')
assert.ok('capabilities' in snapshot && 'scene_controls' in snapshot, 'Capability fields')
assert.equal(snapshot.states_count, 1, 'An empty disposable canvas has one state')

// Each preview goes through the tool's own argv and reply checks.
async function show(file: string, controls?: Record<string, string>) {
  const args = boardArguments({ action: 'preview', file, controls })
  const drawn = preview(await endpoint.run('preview', args, signal), first.link, controls)
  await access(drawn.image_path)
  return drawn
}

// The empty static scene previews its rest view.
const empty = await show(scene_path)
assert.deepEqual([empty.view, empty.state, empty.states_count], ['rest', {}, 1])

// A synthetic controlled scene on this board's basis: the template supplies the content and the
// snapshot scene its scalar basis fields (session, revision, hashes). Its rest view names every
// control; a partial selection names one and the board completes the rest.
const basis = JSON.parse(await readFile(scene_path, 'utf8')) as Record<string, unknown>
const template = JSON.parse(await readFile(controlledScene, 'utf8')) as Record<string, unknown>
assert.ok(object(basis) && object(template), 'Scenes are JSON objects')
const scalars = Object.entries(basis).filter(([, value]) => typeof value !== 'object')
const scene = join(resolve(project), 'whiteboard-smoke-controlled-scene.json')
await writeFile(scene, JSON.stringify({ ...template, ...Object.fromEntries(scalars) }))
const rest = await show(scene)
assert.equal(rest.view, 'rest')
assert.ok(rest.state && Object.keys(rest.state).length >= 2, 'Expected at least two controls')
assert.ok(typeof rest.states_count === 'number' && rest.states_count > 1)
assert.ok(Object.hasOwn(rest.state, control), `The scene has no control ${control}`)
assert.notEqual(rest.state[control], option, 'Select a non-resting option')
const selected = await show(scene, { [control]: option })
assert.equal(selected.view, 'selected')
assert.deepEqual(selected.state, { ...rest.state, [control]: option }, 'Completed at rest')
assert.equal(selected.states_count, rest.states_count)
assert.notEqual(selected.records_hash, rest.records_hash, 'The selection changed the drawing')
assert.equal(await revision(), status.agent_revision, 'A preview must not publish')

// Publish saves the canonical rest scene, never the selected view.
const published = publication(
  await endpoint.run('publish', boardArguments({ action: 'publish', file: scene }), signal),
  first.link,
)
assert.equal(published.records_hash, rest.records_hash, 'Publish the rest view')
assert.notEqual(published.records_hash, selected.records_hash, 'Never the selected view')
assert.equal(await revision(), published.revision)

console.log(
  `Reopened ${first.link.session}; verified protocol ${boardProtocol}, the capabilities ` +
    `artifact, an empty rest preview, a partial selected preview of ${rest.states_count} ` +
    `states, previews that published nothing and canonical revision ${published.revision}. ` +
    `Outstanding events: ${status.events.length}.`,
)
