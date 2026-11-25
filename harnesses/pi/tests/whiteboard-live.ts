// Opt-in only: this opens a real Mac stage and intentionally leaves its board and daemon intact.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { canvasSnapshot, parseLink, parsePoll } from '../src/whiteboard-protocol.ts'

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

const snapshot = await endpoint.run('snapshot', ['--layer', 'canvas'], signal)
canvasSnapshot(snapshot, first.link)
assert.ok(typeof snapshot.path === 'string' && typeof snapshot.records_path === 'string')
assert.equal(snapshot.base_revision, status.agent_revision, 'Expected an idle disposable canvas')
await Promise.all([access(snapshot.path), access(snapshot.records_path)])

console.log(
  `Reopened ${first.link.session}; verified protocol 2 and the canvas snapshot. ` +
    `Outstanding events: ${status.events.length}.`,
)
