// Opt-in only: this opens a real Mac stage and intentionally leaves its board and daemon intact.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { boardProtocol, openBoardEndpoint } from '../src/whiteboard-cli.ts'
import {
  canvasSnapshot,
  parseLink,
  parsePoll,
  preview,
  publication,
} from '../src/whiteboard-protocol.ts'

const [project, owner] = process.argv.slice(2)

if (!project || !owner || !owner.startsWith('whiteboard-smoke-')) {
  throw new Error('Supply a disposable project directory and a whiteboard-smoke- owner ID')
}

const endpoint = await openBoardEndpoint(resolve(project), owner)
const signal = AbortSignal.timeout(60000)
const link = async () => parseLink(await endpoint.run('link', [], signal), owner, endpoint.binding)
const first = await link()
const reopened = await link()
assert.deepEqual(first.link, reopened.link)
const status = parsePoll(await endpoint.run('poll', [], signal), first.link)

const snapshot = await endpoint.run('snapshot', [], signal)
canvasSnapshot(snapshot, first.link)
const { image_path, records_path, scene_path } = snapshot
assert.ok(typeof image_path === 'string' && typeof records_path === 'string')
assert.ok(typeof scene_path === 'string')
assert.equal(snapshot.base_revision, status.agent_revision, 'Expected an idle disposable canvas')
await Promise.all([access(image_path), access(records_path), access(scene_path)])

// The snapshot's own scene is what the canvas shows now. Previewing it must publish nothing;
// publishing it must save exactly the records that were previewed.
const drawn = preview(await endpoint.run('preview', ['--file', scene_path], signal), first.link)
await access(drawn.image_path)
const after = parsePoll(await endpoint.run('poll', [], signal), first.link)
assert.equal(after.agent_revision, status.agent_revision, 'A preview must not publish')
const published = publication(
  await endpoint.run('publish', ['--file', scene_path], signal),
  first.link,
)
assert.equal(published.records_hash, drawn.records_hash, 'Publish what was previewed')

console.log(
  `Reopened ${first.link.session}; verified protocol ${boardProtocol}, the snapshot, a preview ` +
    `that published nothing and revision ${published.revision}. ` +
    `Outstanding events: ${status.events.length}.`,
)
