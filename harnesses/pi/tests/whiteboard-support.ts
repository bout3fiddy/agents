import assert from 'node:assert/strict'
import type { BoardClock } from '../src/whiteboard-feed.ts'
import {
  boardProtocol,
  type BoardCommand,
  type BoardEndpoint,
  type BoardReply,
} from '../src/whiteboard-cli.ts'
import type { BoardEvent } from '../src/whiteboard-protocol.ts'

export function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, wait }
}

export class ManualClock implements BoardClock {
  time = 10000
  delay?: number
  private callback?: () => Promise<void>
  now = () => this.time
  after(ms: number, callback: () => Promise<void>) {
    assert.equal(this.callback, undefined, 'Only one listener may schedule a poll')
    this.delay = ms
    this.callback = callback
    return () => {
      this.callback = undefined
      this.delay = undefined
    }
  }
  tick() {
    assert.ok(this.callback && this.delay, 'Expected scheduled poll')
    this.time += this.delay
    const callback = this.callback
    this.callback = undefined
    this.delay = undefined
    return callback()
  }
}

/** A journal row as the board stores it: include_sketch is absent on a legacy sketch request. */
export type BoardRow = Omit<BoardEvent, 'include_sketch'> & { include_sketch?: boolean }

export class FixtureBoard {
  binding = '/private/fixture.json'
  session = 'board-1'
  events: BoardRow[] = []
  calls: { command: BoardCommand; args: string[] }[] = []
  before?: (command: BoardCommand, args: string[], signal: AbortSignal) => Promise<void>
  private sequence = 0
  add(id: string, text?: string, include_sketch?: boolean) {
    const request_id = '00000000-0000-4000-8000-' + String(++this.sequence).padStart(12, '0')
    this.events.push({
      id,
      kind: 'sketch_notify',
      request_id,
      ...(text === undefined ? {} : { text }),
      ...(include_sketch === undefined ? {} : { include_sketch }),
      sketch_hash: 'source',
      state: 'queued',
      created_at_ms: 100,
    })
  }
  open = async (_cwd: string, owner: string): Promise<BoardEndpoint> => ({
    binding: this.binding,
    run: async (command, args, signal): Promise<BoardReply> => {
      this.calls.push({ command, args })
      await this.before?.(command, args, signal)
      const base = { protocol: boardProtocol, status: 'success', session: this.session, owner }

      if (command === 'link') {
        return {
          ...base,
          draw_url: 'http://fixture/draw',
          stage_url: 'http://fixture/stage',
          binding_file: this.binding,
        }
      }

      if (command === 'ack') {
        const event = this.events.find((e) => e.id === args[1])
        assert.ok(event)

        if (args[3] === 'failed' || args[3] === 'updated') {
          this.events = this.events.filter((e) => e !== event)
        } else {
          event.state = args[3] as BoardEvent['state']
        }

        return base
      }

      if (command === 'snapshot') {
        return {
          ...base,
          snapshot: 'snap-1',
          base_revision: 0,
          prompt: 'Untrusted sketch',
          image_path: '/png',
          records_path: '/records',
          strokes_path: '/strokes',
          scene_path: '/scene',
        }
      }

      if (command === 'preview') {
        return {
          ...base,
          image_path: '/preview',
          records_hash: 'records-1',
          shapes_count: 1,
          published: false,
        }
      }

      if (command === 'publish') {
        return { ...base, revision: 1, records_hash: 'records-1' }
      }

      return {
        ...base,
        sketch_hash: 'source',
        agent_revision: 0,
        events: structuredClone(this.events),
      }
    },
  })
}
