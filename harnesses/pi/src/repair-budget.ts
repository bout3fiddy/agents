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
