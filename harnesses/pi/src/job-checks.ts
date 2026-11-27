import type { Project, Receipt } from './contracts.ts'
import { documentPath, matches } from './paths.ts'
import { benchmarkReceipts } from './project.ts'

/** Paths whose content differs between two inventories, including additions and removals. */
export function changes(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (path) =>
        before.get(path)?.equals(after.get(path) ?? Buffer.alloc(0)) !== true ||
        before.has(path) !== after.has(path),
    )
    .sort()
}

// A changed adapter can alter transaction semantics below an unchanged driver import.
const databaseStatements = new RegExp(
  [
    String.raw`\b(?:create|alter|drop)\s+(?:table|index|schema)|\binsert\s+into\b|`,
    String.raw`\b(?:delete\s+from|begin\s+transaction)\b|\bupdate\s+\w+\s+set\b|`,
    String.raw`\b(?:select\s+[^;\n]{1,200}\s+from|pg_dump|pg_restore|redis-cli)\b|`,
    String.raw`\b(?:db|database|prisma)\.(?:transaction|\$transaction|query|execute)\s*\(`,
  ].join(''),
  'i',
)
const driver =
  '(?:pg|postgres(?:ql)?|psycopg[23]?|sqlite3?|redis|ioredis|prisma|drizzle-orm|' +
  'mongoose|mysql2?|mongodb|knex|sqlalchemy)'
const pythonDatabaseDependency = new RegExp(String.raw`^\s*${driver}(?:\[|\s|[<=>!~;]|$)`, 'im')
const databaseDriver = new RegExp(
  [
    String.raw`(?:\b(?:from|import|require)\s*\(?\s*['"]?(?:node:|better-|@)?${driver}\b|`,
    String.raw`\b(?:from|import|require)\s*\(?\s*['"](?:[@\w.-]+\/)+${driver}['"]|`,
    String.raw`\b${driver}(?:\+\w+)?:\/\/|`,
    String.raw`\b(?:image|engine|provider|dialect|driver)['"]?\s*[:=]\s*['"]?${driver}\b|`,
    String.raw`['"](?:better-|@)?${driver}(?:\/client)?['"]\s*:)`,
  ].join(''),
  'i',
)

export function databaseImpact(
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  paths: string[],
): boolean {
  return changes(before, after).some((path) => {
    if (paths.some((scope) => matches(path, scope)) || /\.(?:sql|prisma)$/i.test(path)) {
      return true
    }

    if (/(?:^|\/)requirements(?:[.-][^/]*)?\.txt$/i.test(path)) {
      return [before.get(path), after.get(path)].some(
        (bytes) => bytes && pythonDatabaseDependency.test(bytes.toString('utf8')),
      )
    }

    if (documentPath(path) || /\.(?:mdx|markdown|adoc)$/i.test(path)) {
      return false
    }

    return [before.get(path), after.get(path)].some((bytes) => {
      if (!bytes || bytes.includes(0)) {
        return false
      }

      let source = bytes.toString('utf8')

      if (/\.[cm]?[jt]sx?$/i.test(path)) {

        // A leading line comment can say "select ... from" in prose. Stop at the first
        // source token so SQL in strings, templates and executable code remains visible.
        source = source.replace(/^(?:[ \t]*\/\/[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)+/, '')
      }

      // NatSpec annotations describe contract behavior in prose.
      const code = path.endsWith('.vy')
        ? source.replace(/^[ \t]*(?:"{3}|'{3})?@(?:notice|dev|param|return)\b[^\n]*/gm, '')
        : source
      return databaseStatements.test(code) || databaseDriver.test(code)
    })
  })
}

export function failedChecks(receipts: Receipt[], project: Project): Receipt[] {
  return receipts.filter(
    (item) =>
      item.status !== 'passed' &&
      (item.check.startsWith('required-') ||
        item.check === 'harness-lint' ||
        project.checks.find((check) => check.id === item.check)?.required),
  )
}

/** Benchmark checks follow the project's execution decision like every other check. */
export const benchmarks = benchmarkReceipts
