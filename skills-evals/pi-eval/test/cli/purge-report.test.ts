import assert from "node:assert/strict";
import test from "node:test";
import { purgeRowsFromReport } from "../../src/cli/purge-report.js";

const STANDALONE_REPORT = [
	"NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.",
	"",
	"# Pi Eval Report",
	"",
	"- Model: test/model",
	"- Commit: abc1234",
	"- Run: 2026-03-03T00:00:00.000Z",
	"- Run scope: full",
	"- Cases executed: 3 (3 rows)",
	"- Case rows: 3 (pass 2, fail 1, skip 0)",
	"- Cases in spec: 3",
	"- Duration: 1m 0s",
	"",
	"## Standalone Results",
	"<!-- UNPAIRED_TABLE_START -->",
	"| Case | Mode | Status | Tokens | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	"| CD-010 | single | PASS | 100 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	"| CD-015-NS-PROBE | single | PASS | 200 | 1 | 1 | 1 | 0 | - | - |  | 2026-03-03 |",
	"| CD-020 | single | FAIL | 300 | 2 | 0 | 0 | 0 | - | - | timeout | 2026-03-03 |",
	"",
	"## Failures",
	"- **CD-020** (single): timeout",
	"",
].join("\n");

const BUNDLE_REPORT = [
	"NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.",
	"",
	"# Pi Eval Report",
	"",
	"- Model: test/model",
	"- Commit: abc1234",
	"- Run: 2026-03-03T00:00:00.000Z",
	"- Run scope: full",
	"- Cases executed: 4 (4 rows)",
	"- Case rows: 4 (pass 3, fail 1, skip 0)",
	"- Cases in spec: 4",
	"- Duration: 2m 0s",
	"",
	"## Bundle Evaluations",
	"",
	"### CD-015: Architectural eval",
	"| Variant | Status | Tokens | Turns | Skills Read | Refs Read |",
	"| --- | --- | --- | --- | --- | --- |",
	"| CD-015:skill | PASS | 500 | 3 | 1 | 2 |",
	"| CD-015:noskill | FAIL | 400 | 2 | 0 | 0 |",
	"",
	"**Judge Verdict** (token cost: 1000)",
	"",
	"| Dimension | skill | noskill | Rationale |",
	"| --- | --- | --- | --- |",
	"| Quality | 8 | 5 | skill version is cleaner |",
	"",
	"> **Recommendation**: Use skill variant",
	"",
	"---",
	"",
	"## Standalone Results",
	"<!-- UNPAIRED_TABLE_START -->",
	"| Case | Mode | Status | Tokens | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	"| CD-010 | single | PASS | 100 | 1 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	"| CD-020 | single | PASS | 300 | 2 | 0 | 0 | 0 | - | - |  | 2026-03-03 |",
	"",
	"## Failures",
	"All cases passed.",
	"",
].join("\n");

test("purge standalone case row", () => {
	const result = purgeRowsFromReport(
		STANDALONE_REPORT,
		new Set(["CD-015-NS-PROBE"]),
		null,
	);

	assert.deepStrictEqual(result.removedRows, ["CD-015-NS-PROBE"]);
	assert.deepStrictEqual(result.removedBundleSections, []);
	assert.ok(!result.updatedContent.includes("CD-015-NS-PROBE"));
	// Other rows preserved
	assert.ok(result.updatedContent.includes("CD-010"));
	assert.ok(result.updatedContent.includes("CD-020"));
});

test("purge standalone case updates header stats", () => {
	const result = purgeRowsFromReport(
		STANDALONE_REPORT,
		new Set(["CD-015-NS-PROBE"]),
		null,
	);

	// After removing 1 PASS row: 2 rows total (pass 1, fail 1, skip 0)
	assert.ok(result.updatedContent.includes("- Case rows: 2 (pass 1, fail 1, skip 0)"));
	assert.ok(result.updatedContent.includes("- Cases in spec: 2"));
});

test("purge bundle variant rows and section", () => {
	const result = purgeRowsFromReport(
		BUNDLE_REPORT,
		new Set(["CD-015:skill", "CD-015:noskill"]),
		"CD-015",
	);

	assert.deepStrictEqual(result.removedBundleSections, ["CD-015"]);
	// Bundle section removed
	assert.ok(!result.updatedContent.includes("### CD-015:"));
	assert.ok(!result.updatedContent.includes("Judge Verdict"));
	// Standalone rows preserved
	assert.ok(result.updatedContent.includes("CD-010"));
	assert.ok(result.updatedContent.includes("CD-020"));
	// Bundle Evaluations heading removed (section now empty)
	assert.ok(!result.updatedContent.includes("## Bundle Evaluations"));
});

test("purge bundle updates header stats", () => {
	const result = purgeRowsFromReport(
		BUNDLE_REPORT,
		new Set(["CD-015:skill", "CD-015:noskill"]),
		"CD-015",
	);

	// After removing bundle rows: only standalone table has CD-010 (PASS) and CD-020 (PASS) = 2 rows
	assert.ok(result.updatedContent.includes("- Case rows: 2 (pass 2, fail 0, skip 0)"));
	assert.ok(result.updatedContent.includes("- Cases in spec: 2"));
});

test("no-op when case not found", () => {
	const result = purgeRowsFromReport(
		STANDALONE_REPORT,
		new Set(["NONEXISTENT-CASE"]),
		null,
	);

	assert.deepStrictEqual(result.removedRows, []);
	assert.deepStrictEqual(result.removedBundleSections, []);
	assert.strictEqual(result.updatedContent, STANDALONE_REPORT);
});
