import type { Receipt } from './contracts.ts'

/** Failed verification rounds allowed at one guidance revision before work returns to the host.
 * Productive repairs reach new guidance or pass well within it; the bound proves termination. */
export const repairRoundsWithoutGuidance = 6

export class RepairBudget {
  private revision: number | undefined
  private rounds = 0

  /** Count a failed round at this guidance revision; true once the budget is spent. */
  failed(revision: number): boolean {
    this.rounds = revision === this.revision ? this.rounds + 1 : 1
    this.revision = revision
    return this.rounds >= repairRoundsWithoutGuidance
  }
}

/** Repository locations a failure names, as path:line[:column] matched against the candidate's
 * files. Edits in a failing file shift these; edits elsewhere leave an unrelated failure identical.
 * Returns undefined when a failed check names no repository location. */
export function failureLocations(receipts: Receipt[], files: Map<string, Buffer>) {
  const parts: string[] = []

  for (const receipt of receipts.filter((item) => item.status !== 'passed')) {
    const locations = new Set<string>()

    for (const token of receipt.result.output.match(/[\w@./-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/g) ??
      []) {
      const [path, ...position] = token.split(':')
      const segments = path!.split('/').filter(Boolean)

      for (let start = 0; start < segments.length; start++) {
        const name = segments.slice(start).join('/')

        if (files.has(name)) {
          locations.add([name, ...position].join(':'))
          break
        }
      }
    }

    if (!locations.size) {
      return undefined
    }

    parts.push(`${receipt.check}:${[...locations].sort().join(',')}`)
  }

  return parts.length ? parts.join('|') : undefined
}

type Failure = { revision: number; snapshot: string; message: string; receipts?: Receipt[] }

/** Tracks one repair loop's failed verifications and stops it when it can no longer progress:
 * an unchanged candidate, the same failure on the same bytes, the same failure locations after
 * edits, or the round budget at one guidance revision. New guidance resets the budget. */
export class RepairProgress {
  private readonly seen = new Set<string>()
  private readonly budget = new RepairBudget()
  private last: Failure | undefined

  constructor(private readonly subject: string) {}

  /** The previous failure an unchanged candidate would only repeat, if any. */
  unchanged(revision: number, snapshot: string): Failure | undefined {
    const last = this.last
    return last?.revision === revision && last.snapshot === snapshot ? last : undefined
  }

  stalledUnchanged(failure: Failure): Error {
    return new Error(
      `${this.subject} made no progress; the candidate is unchanged after: ${failure.message}`,
    )
  }

  /** Record a failed verification; throws once another round cannot make progress. */
  failed(failure: Failure, files: Map<string, Buffer>, cause: unknown): void {
    const exact = `${failure.revision}/${failure.snapshot}/${failure.message}`

    if (this.seen.has(exact)) {
      throw new Error(
        `${this.subject} made no progress on the same candidate: ${failure.message}`,
        { cause },
      )
    }

    // Edits that leave a failure at the same repository locations did not reach it, such as a
    // comment change while an inherited defect fails the gate.
    const located = failure.receipts ? failureLocations(failure.receipts, files) : undefined
    const repeated = located && `${failure.revision}/located/${located}`

    if (repeated && this.seen.has(repeated)) {
      throw new Error(
        `${this.subject} made no progress; the same failure repeated after edits: ` +
          failure.message,
        { cause },
      )
    }

    this.seen.add(exact)

    if (repeated) {
      this.seen.add(repeated)
    }

    if (this.budget.failed(failure.revision)) {
      throw new Error(
        `${this.subject} stopped after ${repairRoundsWithoutGuidance} failed rounds without ` +
          `new guidance: ${failure.message}`,
        { cause },
      )
    }

    this.last = failure
  }
}
