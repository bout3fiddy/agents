// Opt-in only. A real Pi session with a scripted host answers one private chat on a new,
// temporary board served by the real tldraw-sync CLI. The host never snapshots, previews or
// publishes. The temporary project and its board are left for inspection.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { Context } from '@earendil-works/pi-ai'
import { boardProtocol, openBoardEndpoint, type BoardCommand } from '../src/whiteboard-cli.ts'
import type { BoardEvent } from '../src/whiteboard-protocol.ts'
import { registerWhiteboard } from '../src/whiteboard.ts'
import { captureSession } from './session-support.ts'

const waitLimitMs = 10 * 60 * 1000
const wakeMarker = 'Request data (JSON):\n'
const answer = 'I read your note privately and did not open the sketch. 🦦\nCafé — answered once.'

const base = await mkdtemp(join(tmpdir(), 'whiteboard-chat-live-'))
const root = join(base, 'project')
const agent = join(base, 'agent')
await Promise.all([mkdir(root), mkdir(agent)])

// Record every CLI command the Pi runtime and the scripted host send to the real board.
const commands: BoardCommand[] = []
const open: typeof openBoardEndpoint = async (cwd, owner) => {
  const endpoint = await openBoardEndpoint(cwd, owner)
  return {
    ...endpoint,
    run(command, args, signal) {
      commands.push(command)
      return endpoint.run(command, args, signal)
    },
  }
}

type Action = Record<string, string>
const plan: Action[] = []
const results: { action: Action; isError: boolean; text: string }[] = []
let chat: BoardEvent | undefined
const progress = { finished: false }

function text(message: Context['messages'][number] | undefined) {
  const content = message?.content

  if (typeof content === 'string') {
    return content
  }

  return (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

// The scripted host: answer the first private chat once, then try a second answer and check
// status. Sketch requests are finished as failed so the temporary board is left clean.
function planFor(rows: BoardEvent[]) {
  for (const row of rows) {
    if (!row.include_sketch && !chat) {
      chat = row
      plan.push(
        { action: 'ack', event: row.id, state: 'working' },
        { action: 'ack', event: row.id, state: 'updated', message: answer },
        { action: 'ack', event: row.id, state: 'failed', message: 'A second answer' },
        { action: 'status' },
      )
    } else if (row.include_sketch) {
      const message = 'This integration check answers only private chats.'
      plan.push({ action: 'ack', event: row.id, state: 'failed', message })
    }
  }
}

let step = 0
const { session, runtime } = await captureSession(
  root,
  agent,
  [(pi) => registerWhiteboard(pi, open)],
  async (context) => {
    const last = context.messages.at(-1)

    if (last?.role === 'toolResult') {
      results.push({ action: plan[step - 1]!, isError: last.isError, text: text(last) })
    } else if (text(last).includes(wakeMarker)) {
      const wake = text(last)
      planFor(JSON.parse(wake.slice(wake.indexOf(wakeMarker) + wakeMarker.length)))
    }

    const action = plan[step]

    if (!action) {
      progress.finished = chat !== undefined
      return [{ type: 'text', text: 'Done.' }]
    }

    step++
    return [{ type: 'toolCall', id: String(step), name: 'whiteboard', arguments: action }]
  },
)

const errors: string[] = []
const ui = {
  notify(message: string, type?: string) {
    console.log(message)

    if (type === 'error') {
      errors.push(message)
    }
  },
} as unknown as ExtensionUIContext
await session.bindExtensions({ mode: 'tui', uiContext: ui })
await session.prompt('/start_whiteboard')
assert.deepEqual(errors, [], 'The real board must link at protocol ' + boardProtocol)
console.log(
  'Open the iPad URL above. Turn off sharing the sketch, type a note and send it. ' +
    `Waiting up to ${waitLimitMs / 60000} minutes.`,
)

// Bounded wait for the person to send; the listener itself polls every two seconds.
for (let waited = 0; !progress.finished; waited += 1000) {
  assert.ok(waited < waitLimitMs, 'No private chat arrived in time')
  assert.deepEqual(errors, [], 'The listener reported an error')
  await delay(1000)
}

await session.waitForIdle()
assert.ok(chat)
const chatId = chat.id
const answers = results.filter((r) => r.action.event === chatId)
assert.deepEqual(
  answers.map((r) => [r.action.state, r.isError]),
  [
    ['working', false],
    ['updated', false],
    ['failed', true],
  ],
)
assert.match(answers[2]!.text, /not outstanding on this board/)
const status = results.find((r) => r.action.action === 'status')
assert.ok(status && !status.isError && !status.text.includes(JSON.stringify(chatId)))
assert.deepEqual(
  commands.filter((c) => ['snapshot', 'preview', 'publish'].includes(c)),
  [],
  'A private chat never reaches the sketch or the canvas',
)
await session.dispose()
await runtime.settleCredentialWrites()
console.log(
  `Protocol ${boardProtocol}: answered private chat ${chatId} once without sketch access. ` +
    `Temporary project: ${root}`,
)
