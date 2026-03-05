import assert from "node:assert/strict";
import test from "node:test";
import {
	createAccumulator,
	createToolUsageCapture,
	appendAgentEnd,
	shouldFinalize,
	buildReadBreakdown,
} from "../../../src/runtime/worker/worker-accumulator.js";
import type { ReadCapture } from "../../../src/runtime/worker/capture.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const makeAssistantMessage = (text: string, usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	usage,
});

const makeReadCapture = (entries: Array<{ path: string; bytes: number }>): ReadCapture => {
	const capture: ReadCapture = {
		skillAttempts: new Set(),
		skillInvocations: new Set(),
		skillDenied: new Set(),
		skillFileAttempts: new Set(),
		skillFileInvocations: new Set(),
		skillFileDenied: new Set(),
		refAttempts: new Set(),
		refInvocations: new Set(),
		refDenied: new Set(),
		readSizes: new Map(),
	};
	for (const entry of entries) {
		capture.readSizes.set(entry.path, entry.bytes);
	}
	return capture;
};

// ── appendAgentEnd ───────────────────────────────────────────────────────

test("appendAgentEnd accumulates output text and token totals", () => {
	const acc = createAccumulator();
	appendAgentEnd(acc, [makeAssistantMessage("hello")]);
	appendAgentEnd(acc, [makeAssistantMessage("world")]);

	assert.equal(acc.completedTurns, 2);
	assert.equal(acc.outputChunks.length, 2);
	assert.equal(acc.outputChunks[0], "hello");
	assert.equal(acc.outputChunks[1], "world");
	assert.equal(acc.tokenTotals.input, 20);
	assert.equal(acc.tokenTotals.output, 10);
	assert.equal(acc.tokenTotals.cacheRead, 4);
	assert.equal(acc.tokenTotals.cacheWrite, 2);
	assert.equal(acc.tokenTotals.totalTokens, 36);
	assert.equal(acc.turnBreakdown.length, 2);
	assert.equal(acc.turnBreakdown[0].turn, 1);
	assert.equal(acc.turnBreakdown[1].turn, 2);
});

test("appendAgentEnd with countTurn=false skips turn increment and breakdown entry", () => {
	const acc = createAccumulator();
	appendAgentEnd(acc, [makeAssistantMessage("provisional")], false);

	assert.equal(acc.completedTurns, 0);
	assert.equal(acc.turnBreakdown.length, 0);
	assert.equal(acc.outputChunks.length, 1);
	assert.equal(acc.tokenTotals.input, 10);
});

test("appendAgentEnd handles empty messages", () => {
	const acc = createAccumulator();
	appendAgentEnd(acc, []);

	assert.equal(acc.completedTurns, 1);
	assert.equal(acc.outputChunks.length, 0);
	assert.equal(acc.tokenTotals.totalTokens, 0);
});

// ── shouldFinalize ───────────────────────────────────────────────────────

test("shouldFinalize returns false when turns not reached", () => {
	const acc = createAccumulator();
	acc.completedTurns = 1;
	assert.equal(shouldFinalize(acc, 3), false);
	assert.equal(acc.finalized, false);
});

test("shouldFinalize returns true when turns reached", () => {
	const acc = createAccumulator();
	acc.completedTurns = 2;
	assert.equal(shouldFinalize(acc, 2), true);
	assert.equal(acc.finalized, true);
});

test("shouldFinalize returns false on double-finalize", () => {
	const acc = createAccumulator();
	acc.completedTurns = 1;
	assert.equal(shouldFinalize(acc, 1), true);
	assert.equal(shouldFinalize(acc, 1), false);
});

test("shouldFinalize with force=true finalizes even when turns not reached", () => {
	const acc = createAccumulator();
	acc.completedTurns = 0;
	assert.equal(shouldFinalize(acc, 3, true), true);
	assert.equal(acc.finalized, true);
});

// ── createToolUsageCapture ───────────────────────────────────────────────

test("createToolUsageCapture initializes from tool set", () => {
	const capture = createToolUsageCapture(new Set(["write", "read", "edit"]));
	assert.deepEqual(capture.allowedTools, ["edit", "read", "write"]);
	assert.equal(capture.writeCalls, 0);
	assert.equal(capture.editCalls, 0);
	assert.equal(capture.writeFailures, 0);
	assert.equal(capture.editFailures, 0);
});

// ── buildReadBreakdown ──────────────────────────────────────────────────

test("buildReadBreakdown categorizes paths correctly", () => {
	const capture = makeReadCapture([
		{ path: "/workspace/skills/coding/SKILL.md", bytes: 400 },
		{ path: "/workspace/skills/coding/references/guide.md", bytes: 200 },
		{ path: "/workspace/src/main.ts", bytes: 100 },
	]);

	const breakdown = buildReadBreakdown(capture);
	assert.equal(breakdown.length, 3);

	const skillEntry = breakdown.find((e) => e.path.includes("SKILL.md"));
	assert.ok(skillEntry);
	assert.equal(skillEntry.category, "skill");
	assert.equal(skillEntry.bytes, 400);
	assert.equal(skillEntry.estTokens, 100);

	const refEntry = breakdown.find((e) => e.path.includes("references"));
	assert.ok(refEntry);
	assert.equal(refEntry.category, "ref");

	const taskEntry = breakdown.find((e) => e.path.includes("main.ts"));
	assert.ok(taskEntry);
	assert.equal(taskEntry.category, "task");
});

test("buildReadBreakdown returns sorted entries", () => {
	const capture = makeReadCapture([
		{ path: "/z/file.ts", bytes: 10 },
		{ path: "/a/file.ts", bytes: 20 },
		{ path: "/m/file.ts", bytes: 30 },
	]);

	const breakdown = buildReadBreakdown(capture);
	assert.deepEqual(
		breakdown.map((e) => e.path),
		["/a/file.ts", "/m/file.ts", "/z/file.ts"],
	);
});

test("buildReadBreakdown handles empty capture", () => {
	const capture = makeReadCapture([]);
	const breakdown = buildReadBreakdown(capture);
	assert.equal(breakdown.length, 0);
});
