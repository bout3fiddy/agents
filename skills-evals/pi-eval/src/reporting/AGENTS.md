# Reporting Scripts

- `report.ts`: builds/parses markdown reports and index rows. Delegates shared table parsing to `report-document.ts`.
- `report-document.ts`: shared markdown report table parsing primitives (sentinels, cell extraction, column indexing, table boundaries, row parsing, header stats recalculation).
- `report-persistence.ts`: report write locking and index updates.
