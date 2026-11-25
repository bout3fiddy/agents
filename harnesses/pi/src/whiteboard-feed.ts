import { lstat } from 'node:fs/promises'
import type {
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { invariant } from './invariant.ts'
import { hostWorkPaused } from './host-work.ts'
import { MissingBoardCLI, object, type BoardEndpoint } from './whiteboard-cli.ts'
import {
  batchLimit,
  boardArguments,
  parsePoll,
  publication,
  validRevision,
  sameBoard,
  type BoardEvent,
  type BoardInput,
  type BoardLink,
} from './whiteboard-protocol.ts'

export const boardMessage = 'pi-whiteboard-events'
export interface BoardClock {
  now: () => number
  after: (ms: number, callback: () => Promise<void>) => () => void
}
export const boardClock: BoardClock = {
  now: Date.now,
  after(ms, callback) {
    const timer = setTimeout(() => {
      void callback()
    }, ms)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

/** Only look up receipts for this bounded set of outstanding IDs, not the lifetime of a board. */
function receipts(entries: SessionEntry[], link: BoardLink, events: BoardEvent[]) {
  const missing = new Set(events.map((event) => event.id))
  let lastWake = -Infinity

  for (let i = entries.length - 1; i >= 0 && missing.size; i--) {
    const entry = entries[i]!

    if (entry.type !== 'custom_message' || entry.customType !== boardMessage) {
      continue
    }

    const details: unknown = entry.details

    if (
      !object(details) ||
      details.owner !== link.owner ||
      details.session !== link.session ||
      !Array.isArray(details.ids) ||
      details.ids.length > batchLimit
    ) {
      continue
    }

    if (typeof details.time === 'number') {
      lastWake = Math.max(lastWake, details.time)
    }

    for (const id of details.ids) {
      missing.delete(id)
    }
  }

  return { missing, lastWake }
}

/** One instance per attached generation. Never reuse its poll, timer or cancellation signal. */
export class BoardFeed {
  private flight?: Promise<ReturnType<typeof parsePoll>>
  private cancelTimer?: () => void
  private failures = 0
  private events: BoardEvent[] = []
  private nextWake = -Infinity
  private seen = new Set<string>()
  private acting = false
  private receiving?: Promise<void>
  private retryAfter?: string

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    readonly link: BoardLink,
    private readonly endpoint: BoardEndpoint,
    private readonly signal: AbortSignal,
    private readonly clock: BoardClock,
  ) {}

  private current() {
    this.signal.throwIfAborted()

    if (this.ctx.sessionManager.getSessionId() !== this.link.owner) {
      throw new Error('Whiteboard session changed')
    }
  }

  private poll() {
    this.current()
    this.flight ??= this.endpoint
      .run('poll', [], this.signal)
      .then((data) => {
        this.current()
        const status = parsePoll(data, this.link)
        this.events = status.events

        if (this.seen.size) {
          this.seen = new Set(
            this.events.map((event) => event.id).filter((id) => this.seen.has(id)),
          )
        }

        return status
      })
      .finally(() => {
        this.flight = undefined
      })
    return this.flight
  }

  private async received(event: BoardEvent) {
    this.current()
    await this.endpoint.run('ack', ['--event', event.id, '--state', 'received'], this.signal)
    this.current()
    event.state = 'received'
  }

  // Pi buffers setup entries (including a first idle wake) until a user or assistant message.
  private async flushed() {
    const file = this.ctx.sessionManager.getSessionFile()

    if (!file) {
      return false
    }

    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
    this.current()
    return info?.isFile() === true
  }

  private async reconcile() {
    const queued = this.events.filter((e) => e.state === 'queued')

    if (!queued.length || !(await this.flushed())) {
      return
    }

    const { missing } = receipts(this.ctx.sessionManager.getBranch(), this.link, queued)

    const ready = queued.filter((event) => !missing.has(event.id))
    const start = 1 + ready.findIndex((event) => event.id === this.retryAfter)

    for (let i = 0; i < Math.min(ready.length, batchLimit); i++) {
      const event = ready[(start + i) % ready.length]!
      this.retryAfter = event.id
      await this.received(event)
    }

    this.retryAfter = undefined
  }

  private message(ctx: ExtensionContext): CustomMessageEntryDraft | undefined {
    this.current()
    const time = this.clock.now()

    if (!this.events.length || time < this.nextWake || ctx.hasPendingMessages()) {
      return
    }

    const candidates = this.events.filter((event) => !this.seen.has(event.id))

    if (!candidates.length || hostWorkPaused(ctx)) {
      return
    }

    // Sibling branches may already have consumed a wake. Never import their conversation or
    // authorize an ACK from them; consult only receipt IDs for this owner and bound board.
    const { missing, lastWake } = receipts(ctx.sessionManager.getEntries(), this.link, candidates)

    for (const event of candidates) {
      if (!missing.has(event.id)) {
        this.seen.add(event.id)
      }
    }

    if (!missing.size || time < lastWake + 5000) {
      return
    }

    const batch = this.events.filter((e) => missing.has(e.id)).slice(0, batchLimit)

    invariant(batch.length > 0 && batch.length <= batchLimit, 'Invalid whiteboard wake batch')

    // Throttle attempts, not delivery: a dropped draft remains eligible without a receipt.
    this.nextWake = time + 5000
    return {
      type: 'custom_message',
      customType: boardMessage,
      display: true,
      details: { ...this.link, ids: batch.map((e) => e.id), time },
      content:
        'Whiteboard requests for this conversation. Use the whiteboard tool; ' +
        'honor each request kind and prioritize newer user input.\n' +
        JSON.stringify(batch),
    }
  }

  boundary(event: BoundaryState, ctx: ExtensionContext) {
    if (event.outcome !== 'completed' || event.context.pendingMessages.length) {
      return
    }

    const message = this.message(ctx)

    if (message) {
      return { entries: [...event.entries, message], continue: true }
    }
  }

  private deliverIdle() {
    this.current()

    if (this.ctx.isIdle()) {
      const message = this.message(this.ctx)

      if (message) {
        this.pi.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' })
      }
    }
  }

  schedule() {
    this.cancelTimer = this.clock.after(this.failures >= 5 ? 10000 : 2000, async () => {
      try {
        this.current()
      } catch {

        // The SDK can dispose an extension context without a shutdown event.
        return
      }

      let polled = false

      try {
        await this.poll()
        this.current()
        polled = true

        try {
          if (!this.acting) {
            this.receiving = this.reconcile()
            await this.receiving
          }
        } finally {

          // A rejected receipt must not suppress independent, newly polled requests.
          this.deliverIdle()
        }

        if (this.failures >= 5) {
          this.ctx.ui.notify('Whiteboard listener recovered.', 'info')
        }

        this.failures = 0
      } catch (error) {
        if (this.signal.aborted) {
          return
        }

        if (!polled) {
          this.events = []
        }

        if (error instanceof MissingBoardCLI) {
          this.ctx.ui.notify(error.message, 'error')
          return
        }

        if (++this.failures === 5) {
          this.ctx.ui.notify(
            'Whiteboard listener unavailable. Retrying every 10 seconds. Check /start_whiteboard.',
            'warning',
          )
        }
      } finally {
        this.receiving = undefined
      }

      if (!this.signal.aborted) {
        this.schedule()
      }
    })
  }

  stop() {
    this.cancelTimer?.()
  }

  async action(input: BoardInput, cancel?: AbortSignal) {
    this.current()

    if (this.acting) {
      throw new Error('A whiteboard tool action is already in progress')
    }

    this.acting = true
    const signal = cancel ? AbortSignal.any([cancel, this.signal]) : this.signal

    try {

      // The listener reports receipt failures. Recheck this action's own preconditions below.
      await this.receiving?.catch(() => {})
      const args = boardArguments(input)
      signal.throwIfAborted()

      const status = await this.poll()
      signal.throwIfAborted()

      if (input.action === 'status') {
        return status
      }

      if (input.action === 'ack') {
        const event = status.events.find((e) => e.id === input.event)

        if (event?.state === 'queued') {
          if (
            !(await this.flushed()) ||
            receipts(this.ctx.sessionManager.getBranch(), this.link, [event]).missing.size
          ) {
            throw new Error('Whiteboard event has not been delivered in this conversation')
          }

          await this.received(event)
        }
      }

      signal.throwIfAborted()
      const data = await this.endpoint.run(input.action, args, signal)
      this.current()

      if (input.action === 'ack') {
        if ('session' in data) {
          sameBoard(data, this.link)
        }

        this.events = this.events.filter((e) => e.id !== input.event)
        return { ...this.link, event: input.event, state: input.state }
      }

      if (input.action === 'publish') {
        return publication(data, this.link, input.layer)
      }

      sameBoard(data, this.link)

      if ('layer' in data && data.layer !== input.layer) {
        throw new Error('Whiteboard snapshot belongs to a different layer')
      }

      return snapshotView(data)
    } finally {
      this.acting = false
    }
  }
}

function snapshotView(data: Record<string, unknown>) {
  if (
    typeof data.path !== 'string' ||
    typeof data.records_path !== 'string' ||
    typeof data.prompt !== 'string' ||
    !data.snapshot ||
    !validRevision(data.base_revision)
  ) {
    throw new Error('Whiteboard snapshot missing image, records, revision or prompt')
  }

  return data
}
