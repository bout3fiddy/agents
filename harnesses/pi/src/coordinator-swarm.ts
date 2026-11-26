import { invariant } from './invariant.ts'

// Research swarms: a coordinator-chosen group of read-only researchers that start together.
// This module has no package dependencies, so its contract runs under plain Node type stripping.

/** A short label the coordinator chooses. It tells apart siblings sharing a role and scope. */
export const researcherIdPattern = '^[a-z0-9][a-z0-9-]{0,39}$'

export type SwarmOutcome<Value> =
  | { id: string; status: 'completed'; value: Value }
  | { id: string; status: 'failed'; capacity: boolean; error: unknown }

export type SwarmReport<Value> = {
  swarm: { size: number; completed: number; failed: number; capacityFailures: number }
  researchers: (
    | { id: string; status: 'completed'; evidence: Value }
    | { id: string; status: 'failed'; capacity: boolean; error: string; retryAt?: number }
  )[]
  unfinished: string[]
  instruction?: string
}

// Operating-system refusals to start or feed another process. A provider quota carries retryAt.
const exhaustedCodes = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOBUFS'])
const errorTextLimit = 500

function retryTime(error: unknown): number | undefined {
  const retryAt = (error as { retryAt?: unknown } | null)?.retryAt
  return typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt : undefined
}

/** True when the failure reports exhausted capacity rather than a defect in the assignment. */
export function capacityFailure(error: unknown): boolean {

  // An error and its direct cause: a wrapped spawn failure keeps its code one level down.
  const layers = [error, (error as { cause?: unknown } | null)?.cause]

  for (const layer of layers) {
    const code = (layer as { code?: unknown } | null)?.code

    if (retryTime(layer) !== undefined || (typeof code === 'string' && exhaustedCodes.has(code))) {
      return true
    }
  }

  return false
}

/** Identities that occur more than once, sorted for a stable message. */
export function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()

  for (const id of ids) {
    if (seen.has(id)) {
      repeated.add(id)
    }

    seen.add(id)
  }

  return [...repeated].sort()
}

/** Start every researcher in one synchronous pass and wait until each has settled once.
 *
 * Nothing waits behind a sibling, so there is no queue to bound: the group is exactly the finite
 * list the coordinator chose. A researcher that cannot start or finish becomes its own failed
 * outcome and never disturbs a sibling. Cancellation rejects only after every sibling stopped. */
export async function dispatchSwarm<Member extends { id: string }, Value>(
  members: readonly Member[],
  start: (member: Member) => Promise<Value>,
  signal: AbortSignal,
): Promise<SwarmOutcome<Value>[]> {
  invariant(members.length > 0, 'a research swarm has at least one researcher')
  invariant(
    duplicateIds(members.map((member) => member.id)).length === 0,
    'researcher identities are unique within a swarm',
  )
  signal.throwIfAborted()
  const attempts: Promise<Value>[] = []

  for (const member of members) {

    // The executor runs now, so a synchronous refusal to start becomes this member's rejection.
    attempts.push(new Promise<Value>((resolve) => resolve(start(member))))
  }

  const settled = await Promise.allSettled(attempts)
  invariant(settled.length === members.length, 'every researcher settles exactly once')
  signal.throwIfAborted()
  return settled.map((attempt, index): SwarmOutcome<Value> => {
    const { id } = members[index]!
    return attempt.status === 'fulfilled'
      ? { id, status: 'completed', value: attempt.value }
      : {
          id,
          status: 'failed',
          capacity: capacityFailure(attempt.reason),
          error: attempt.reason,
        }
  })
}

/** The coordinator-visible result: one entry per researcher and the ids still without findings. */
export function swarmReport<Value>(outcomes: readonly SwarmOutcome<Value>[]): SwarmReport<Value> {
  const ids = outcomes.map((outcome) => outcome.id)
  invariant(duplicateIds(ids).length === 0, 'each researcher is reported exactly once')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const capacityFailures = failed.filter((outcome) => outcome.capacity).length
  const report: SwarmReport<Value> = {
    swarm: {
      size: outcomes.length,
      completed: outcomes.length - failed.length,
      failed: failed.length,
      capacityFailures,
    },
    researchers: outcomes.map((outcome) => {
      if (outcome.status === 'completed') {
        return { id: outcome.id, status: outcome.status, evidence: outcome.value }
      }

      const retryAt = retryTime(outcome.error)
      return {
        id: outcome.id,
        status: outcome.status,
        capacity: outcome.capacity,
        error: String(outcome.error).slice(0, errorTextLimit),
        ...(retryAt !== undefined && { retryAt }),
      }
    }),
    unfinished: failed.map((outcome) => outcome.id),
  }

  if (capacityFailures) {
    report.instruction =
      'Capacity ran out before the unfinished researchers completed. Nothing is queued or ' +
      'retried for you. Dispatch the unfinished ids again in a smaller group once capacity ' +
      'returns, or submit blocked with this evidence.'
  } else if (failed.length) {
    report.instruction =
      'The unfinished researchers failed. Dispatch each unfinished id again with its ' +
      'assignment, or submit blocked with this evidence.'
  }

  return report
}

/** Activity of concurrently running children, keyed by identity and never by role, so same-role
 * siblings stay distinct and a parent never points at a child that already finished. */
export class ActiveSiblings<Activity> {
  private readonly active = new Map<string, Activity>()

  get size(): number {
    return this.active.size
  }

  start(key: string, activity: Activity): void {
    invariant(!this.active.has(key), `sibling ${key} starts once`)
    this.active.set(key, activity)
  }

  /** Record fresh activity. A report that arrives after its sibling finished is dropped. */
  update(key: string, activity: Activity): boolean {
    if (!this.active.delete(key)) {
      return false
    }

    // Reinsertion keeps the map ordered by most recent activity.
    this.active.set(key, activity)
    return true
  }

  finish(key: string): void {
    invariant(this.active.delete(key), `sibling ${key} finishes once`)
  }

  /** The running sibling with the most recent activity. */
  current(): Activity | undefined {
    let latest: Activity | undefined

    for (const activity of this.active.values()) {
      latest = activity
    }

    return latest
  }
}
