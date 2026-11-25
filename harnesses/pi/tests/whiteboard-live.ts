// Opt-in only: this opens a real Mac stage and intentionally leaves its board and daemon intact.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openBoardEndpoint } from '../src/whiteboard-cli.ts'
import { parseLink, parsePoll, sameBoard, validRevision } from '../src/whiteboard-protocol.ts'

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

for (const layer of ['interpretation', 'ideas']) {
  const snapshot = await endpoint.run('snapshot', ['--layer', layer], signal)
  sameBoard(snapshot, first.link)
  assert.ok(typeof snapshot.path === 'string' && typeof snapshot.records_path === 'string')
  assert.ok(snapshot.snapshot && validRevision(snapshot.base_revision))
  await Promise.all([access(snapshot.path), access(snapshot.records_path)])
}

console.log(
  `Reopened ${first.link.session}; verified both snapshot layers. ` +
    `Outstanding events: ${status.events.length}.`,
)
