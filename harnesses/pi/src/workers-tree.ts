import type { WorkerRow } from './workers-data.ts'

export type WorkerNode = { row: WorkerRow; depth: number; context: boolean }

/** Keep ancestors and the reviewed author visible, even when they belong to the other tab. */
export function workerTree(rows: WorkerRow[], active: boolean): WorkerNode[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const parent = (row: WorkerRow) => row.info.reviewOf ?? row.info.parentId
  const included = new Set(rows.filter((row) => row.active === active).map((row) => row.id))

  for (const id of [...included]) {
    let cursor = byId.get(id)
    const seen = new Set<string>()

    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      included.add(cursor.id)
      cursor = byId.get(parent(cursor) ?? '')
    }
  }

  const result: WorkerNode[] = []
  const visited = new Set<string>()
  const append = (row: WorkerRow, depth: number) => {
    if (visited.has(row.id) || !included.has(row.id)) {
      return
    }

    visited.add(row.id)
    result.push({ row, depth: Math.min(depth, 6), context: row.active !== active })

    for (const child of rows
      .filter((candidate) => parent(candidate) === row.id)
      .sort((left, right) => left.info.startedAt.localeCompare(right.info.startedAt))) {
      append(child, depth + 1)
    }
  }

  for (const row of rows.filter((item) => !byId.has(parent(item) ?? ''))) {
    append(row, 0)
  }

  for (const row of rows) {
    append(row, 0)
  }

  return result
}
