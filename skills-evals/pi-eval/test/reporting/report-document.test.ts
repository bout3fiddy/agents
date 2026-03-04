import assert from "node:assert/strict";
import test from "node:test";
import {
	UNPAIRED_TABLE_SENTINEL,
	buildColumnIndex,
	buildRowKey,
	cellStr,
	extractRowCells,
	findTableBoundaries,
	normalizeStatus,
	parseStandaloneTable,
	recalculateHeaderStats,
	safeParseInt,
} from "../../src/reporting/report-document.js";

// ── extractRowCells ─────────────────────────────────────────────────────

test("extractRowCells splits markdown table row into trimmed cells", () => {
	const cells = extractRowCells("| CD-010 | single | PASS | 100 |");
	assert.deepStrictEqual(cells, ["CD-010", "single", "PASS", "100"]);
});

test("extractRowCells handles extra whitespace", () => {
	const cells = extractRowCells("|  foo  |  bar  |");
	assert.deepStrictEqual(cells, ["foo", "bar"]);
});

// ── safeParseInt ────────────────────────────────────────────────────────

test("safeParseInt parses valid integers", () => {
	assert.equal(safeParseInt("42"), 42);
	assert.equal(safeParseInt("0"), 0);
});

test("safeParseInt returns 0 for non-numeric values", () => {
	assert.equal(safeParseInt("abc"), 0);
	assert.equal(safeParseInt(""), 0);
	assert.equal(safeParseInt("-"), 0);
});

// ── cellStr ─────────────────────────────────────────────────────────────

test("cellStr returns cell value when index is valid", () => {
	assert.equal(cellStr(["a", "b", "c"], 1, "default"), "b");
});

test("cellStr returns fallback when index is -1", () => {
	assert.equal(cellStr(["a"], -1, "default"), "default");
});

// ── buildColumnIndex ────────────────────────────────────────────────────

test("buildColumnIndex finds columns case-insensitively", () => {
	const col = buildColumnIndex(["Case", "Mode", "Status"]);
	assert.equal(col("case"), 0);
	assert.equal(col("MODE"), 1);
	assert.equal(col("Status"), 2);
	assert.equal(col("nonexistent"), -1);
});

// ── findTableBoundaries ─────────────────────────────────────────────────

test("findTableBoundaries locates sentinel and header", () => {
	const lines = [
		"# Report",
		"",
		UNPAIRED_TABLE_SENTINEL,
		"| Case | Mode | Status |",
		"| --- | --- | --- |",
		"| CD-010 | single | PASS |",
	];
	const result = findTableBoundaries(lines);
	assert.equal(result.sentinelIndex, 2);
	assert.equal(result.headerIndex, 3);
	assert.equal(result.dataStart, 5);
});

test("findTableBoundaries works without sentinel", () => {
	const lines = [
		"# Report",
		"| Case | Mode |",
		"| --- | --- |",
	];
	const result = findTableBoundaries(lines);
	assert.equal(result.sentinelIndex, -1);
	assert.equal(result.headerIndex, 1);
	assert.equal(result.dataStart, 3);
});

test("findTableBoundaries returns -1 when no table found", () => {
	const lines = ["# Report", "No table here"];
	const result = findTableBoundaries(lines);
	assert.equal(result.headerIndex, -1);
	assert.equal(result.dataStart, -1);
});

// ── buildRowKey ─────────────────────────────────────────────────────────

test("buildRowKey produces caseId::mode key", () => {
	assert.equal(buildRowKey("CD-010", "single"), "CD-010::single");
});

// ── normalizeStatus ─────────────────────────────────────────────────────

test("normalizeStatus uppercases and trims", () => {
	assert.equal(normalizeStatus(" pass "), "PASS");
	assert.equal(normalizeStatus("Fail"), "FAIL");
});

// ── parseStandaloneTable ────────────────────────────────────────────────

const TABLE_LINES = [
	"## Standalone Results",
	UNPAIRED_TABLE_SENTINEL,
	"| Case | Mode | Status | Tokens | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	"| CD-010 | single | PASS | 100 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	"| CD-020 | single | FAIL | 300 | 2 | 0 | 0 | 0 | - | - | timeout | 2026-03-03 |",
	"",
];

test("parseStandaloneTable parses old-format (Tokens column) rows correctly", () => {
	const rows = parseStandaloneTable(TABLE_LINES);
	assert.equal(rows.size, 2);
	const row1 = rows.get("CD-010::single");
	assert.ok(row1);
	assert.equal(row1.caseId, "CD-010");
	assert.equal(row1.mode, "single");
	assert.equal(row1.status, "PASS");
	assert.equal(row1.apiCost, 100, "old-format falls back Tokens → apiCost");
	assert.equal(row1.cached, 0, "old-format has no Cached column");
	assert.equal(row1.turns, 1);

	const row2 = rows.get("CD-020::single");
	assert.ok(row2);
	assert.equal(row2.status, "FAIL");
	assert.equal(row2.notes, "timeout");
});

const NEW_FORMAT_TABLE_LINES = [
	"## Standalone Results",
	UNPAIRED_TABLE_SENTINEL,
	"| Case | Mode | Status | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	"| CD-010 | single | PASS | 80 | 200 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	"| CD-020 | single | FAIL | 150 | 500 | 2 | 0 | 0 | 0 | - | - | timeout | 2026-03-03 |",
	"",
];

test("parseStandaloneTable parses new-format (Cost/Cached columns) rows", () => {
	const rows = parseStandaloneTable(NEW_FORMAT_TABLE_LINES);
	assert.equal(rows.size, 2);
	const row1 = rows.get("CD-010::single");
	assert.ok(row1);
	assert.equal(row1.apiCost, 80, "new-format reads Cost column");
	assert.equal(row1.cached, 200, "new-format reads Cached column");
	assert.equal(row1.turns, 1);

	const row2 = rows.get("CD-020::single");
	assert.ok(row2);
	assert.equal(row2.apiCost, 150);
	assert.equal(row2.cached, 500);
});

test("parseStandaloneTable returns empty map for missing table", () => {
	const rows = parseStandaloneTable(["# No table"]);
	assert.equal(rows.size, 0);
});

// ── recalculateHeaderStats ──────────────────────────────────────────────

test("recalculateHeaderStats updates header lines in place", () => {
	const lines = [
		"- Case rows: 999 (pass 999, fail 999, skip 999)",
		"- Cases in spec: 999",
		"",
		UNPAIRED_TABLE_SENTINEL,
		"| Case | Mode | Status | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		"| CD-010 | single | PASS | 80 | 200 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
		"| CD-020 | single | FAIL | 150 | 500 | 2 | 0 | 0 | 0 | - | - | timeout | 2026-03-03 |",
	];
	recalculateHeaderStats(lines);
	assert.equal(lines[0], "- Case rows: 2 (pass 1, fail 1, skip 0)");
	assert.equal(lines[1], "- Cases in spec: 2");
});

test("recalculateHeaderStats counts bundle variant rows", () => {
	const lines = [
		"- Case rows: 0 (pass 0, fail 0, skip 0)",
		"- Cases in spec: 0",
		"",
		"| Variant | Status | Cost | Cached | Turns | Skills Read | Refs Read |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		"| CD-015:skill | PASS | 300 | 500 | 3 | 1 | 2 |",
		"| CD-015:noskill | FAIL | 200 | 400 | 2 | 0 | 0 |",
		"",
		UNPAIRED_TABLE_SENTINEL,
		"| Case | Mode | Status | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		"| CD-010 | single | PASS | 80 | 200 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	];
	recalculateHeaderStats(lines);
	assert.equal(lines[0], "- Case rows: 3 (pass 2, fail 1, skip 0)");
	assert.equal(lines[1], "- Cases in spec: 3");
});
