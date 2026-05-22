# Reporting Scripts

- `report.ts`: builds markdown reports from a short run header, optional judge-authored suite report, structured comparison/skill-feedback sections, and one parseable case-row table. The table separates per-run `Task` outcome from `Judge` comparison outcome.
- `report-document.ts`: shared markdown report table parsing primitives (judge-report sentinels, case-row table sentinel, cell extraction, column indexing, table boundaries, row parsing, header stats recalculation).
- `report-persistence.ts`: report write locking, index updates, per-case routing trace writes, and suite-level judge verdict persistence.
