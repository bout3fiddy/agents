import assert from 'node:assert/strict'
import type { BoardClock } from '../src/whiteboard-feed.ts'
import type { BoardCommand, BoardEndpoint, BoardReply } from '../src/whiteboard-cli.ts'
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

export class FixtureBoard {
  binding = '/private/fixture.json'
  session = 'board-1'
  events: BoardEvent[] = []
  calls: { command: BoardCommand; args: string[] }[] = []
  before?: (command: BoardCommand, args: string[], signal: AbortSignal) => Promise<void>
  add(id: string, kind: BoardEvent['kind'] = 'sketch_notify') {
    this.events.push({ id, kind, sketch_hash: 'source', state: 'queued', created_at_ms: 100 })
  }
  open = async (_cwd: string, owner: string): Promise<BoardEndpoint> => ({
    binding: this.binding,
    run: async (command, args, signal): Promise<BoardReply> => {
      this.calls.push({ command, args })
      await this.before?.(command, args, signal)
      const base = { status: 'success', session: this.session, owner }

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
          layer: args[1],
          snapshot: 'snap-1',
          base_revision: 0,
          prompt: 'Untrusted diagram',
          path: '/png',
          records_path: '/records',
          diagram_path: '/diagram',
        }
      }

      if (command === 'publish') {
        return { ...base, layer: args[1], revision: 1 }
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
