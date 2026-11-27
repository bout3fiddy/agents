import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { invariant } from './invariant.ts'

// Opening of the error every member of an invalidated SDK extension context throws.
const staleContext = 'This extension ctx is stale'

/**
 * The session ctx serves, or undefined once the SDK has invalidated ctx. Disposing a session
 * invalidates its contexts without emitting session_shutdown, and the SDK exposes no other
 * liveness probe. Only that invalidation counts as a lost session; any other failure propagates.
 * tests/task-notifications.test.ts replays the disposal against the installed SDK.
 */
export function liveSession(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(staleContext)) {
      return undefined
    }

    throw error
  }
}

export type DeliveryLimits = {

  /** Idle wakes offered for one notification before it is reported undelivered. */
  attempts: number

  /** Delay before the first repeat; each further repeat doubles it. */
  retryMs: number

  /** Longest delay between repeats. */
  maxRetryMs: number

  /** Offers remembered at once. The oldest is forgotten first and may be offered again. */
  capacity: number
}

export const deliveryLimits: DeliveryLimits = {
  attempts: 5,
  retryMs: 5000,
  maxRetryMs: 300000,
  capacity: 1024,
}

type Offer = {

  /** Idle wakes offered, and when the next one may follow. */
  attempts: number
  nextAt: number

  /** Appends offered at a turn boundary, and when the next one may follow. */
  appends: number
  appendAt: number
  reported: boolean
}

/**
 * Notifications offered to a session and not yet acknowledged by a persisted receipt.
 *
 * Offering a wake is not delivery: the SDK starts the run asynchronously and reports a failed
 * start only to its error channel. The receipt in the session is the acknowledgement. Until it
 * appears, the offer becomes due again after a growing delay, so a dropped wake is repeated a
 * bounded number of times and never in a tight loop.
 *
 * A turn that is already running appends at its boundary without starting anything, so a
 * boundary may deliver at once whatever happened to earlier idle wakes. Boundary offers follow
 * their own growing delay, which keeps an append that never persists from continuing forever.
 */
export class DeliveryLedger {
  private readonly offers = new Map<string, Offer>()

  constructor(readonly limits: DeliveryLimits = deliveryLimits) {
    invariant(limits.attempts >= 1 && limits.capacity >= 1, 'delivery limits must be positive')
    invariant(limits.retryMs >= 1 && limits.maxRetryMs >= limits.retryMs, 'invalid retry delay')
  }

  get size() {
    return this.offers.size
  }

  private delay(offered: number) {
    invariant(offered >= 1, 'a delay follows at least one offer')
    return Math.min(this.limits.retryMs * 2 ** Math.min(offered - 1, 30), this.limits.maxRetryMs)
  }

  /** An idle wake may be offered: bounded by attempts as well as by time. */
  dueWhileIdle(key: string, now: number) {
    const offer = this.offers.get(key)
    return !offer || (now >= offer.nextAt && offer.attempts < this.limits.attempts)
  }

  /** A boundary append may be offered: bounded by time alone. */
  dueAtBoundary(key: string, now: number) {
    const offer = this.offers.get(key)
    return !offer || now >= offer.appendAt
  }

  offer(key: string, now: number, boundary = false) {
    const offer = this.offers.get(key) ?? {
      attempts: 0,
      nextAt: 0,
      appends: 0,
      appendAt: 0,
      reported: false,
    }

    if (boundary) {
      offer.appends++
      offer.appendAt = now + this.delay(offer.appends)

      // The append is expected to persist; give its receipt time before another idle wake.
      offer.nextAt = Math.max(offer.nextAt, now + this.limits.retryMs)
    } else {
      offer.attempts++
      offer.nextAt = now + this.delay(offer.attempts)
    }

    this.offers.delete(key)
    this.offers.set(key, offer)

    while (this.offers.size > this.limits.capacity) {
      const oldest = this.offers.keys().next().value
      invariant(oldest !== undefined, 'a non-empty ledger has an oldest offer')
      this.offers.delete(oldest)
    }
  }

  /** Undo an idle offer that was prepared and never sent, so the next owner still delivers. */
  retract(key: string) {
    const offer = this.offers.get(key)

    if (!offer) {
      return
    }

    if (offer.attempts <= 1 && !offer.appends) {
      this.offers.delete(key)
    } else {
      offer.attempts = Math.max(0, offer.attempts - 1)
      offer.nextAt = 0
    }
  }

  /** The receipt is persisted. Returns whether an offer was outstanding. */
  acknowledge(key: string) {
    return this.offers.delete(key)
  }

  attempts(key: string) {
    return this.offers.get(key)?.attempts ?? 0
  }

  /**
   * Keys whose idle attempts are spent and whose last delay has passed without a receipt. Each
   * key is returned once, so its owner reports the blocker a single time.
   */
  exhausted(now: number): string[] {
    const keys: string[] = []

    for (const [key, offer] of this.offers) {
      if (!offer.reported && offer.attempts >= this.limits.attempts && now >= offer.nextAt) {
        offer.reported = true
        keys.push(key)
      }
    }

    return keys
  }
}
