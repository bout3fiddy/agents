import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeoutDiagnosticsHint, createRpcDiagnosticsTracker } from "../../../src/runtime/rpc/rpc-diagnostics.js";
import type { RpcDiagnostics } from "../../../src/data/types.js";

test("createRpcDiagnosticsTracker records raw lines and events", () => {
	const tracker = createRpcDiagnosticsTracker();
	tracker.recordRawLine();
	tracker.recordRawLine();
	tracker.recordEvent({ type: "agent_end", messages: [] });
	const summary = tracker.toSummary();
	assert.equal(summary.rawLineCount, 2);
	assert.equal(summary.parsedEventCount, 1);
	assert.equal(summary.eventCounts.agent_end, 1);
});

test("createRpcDiagnosticsTracker tracks parse errors", () => {
	const tracker = createRpcDiagnosticsTracker();
	tracker.recordParseError();
	tracker.recordParseError();
	const summary = tracker.toSummary();
	assert.equal(summary.parseErrorCount, 2);
});

test("createRpcDiagnosticsTracker records auto retry events", () => {
	const tracker = createRpcDiagnosticsTracker();
	tracker.recordEvent({ type: "auto_retry_start" });
	tracker.recordEvent({ type: "auto_retry_end", success: true });
	const summary = tracker.toSummary();
	assert.equal(summary.autoRetryStartCount, 1);
	assert.equal(summary.autoRetryEndCount, 1);
});

test("createRpcDiagnosticsTracker detects incomplete tool calls", () => {
	const tracker = createRpcDiagnosticsTracker();
	tracker.recordEvent({
		type: "toolcall_delta",
		toolCall: { name: "read", id: "tc1" },
		partialJson: '{"path": "/foo"}',
	});
	// No toolcall_end or execution_start
	const summary = tracker.toSummary();
	assert.ok(summary.anomalies.length > 0);
	assert.ok(summary.anomalies[0].includes("incomplete tool call"));
});

test("createRpcDiagnosticsTracker tracks terminal agent errors", () => {
	const tracker = createRpcDiagnosticsTracker();
	tracker.recordEvent({
		type: "agent_end",
		messages: [
			{ role: "assistant", stopReason: "error", errorMessage: "terminated" },
		],
	});
	const summary = tracker.toSummary();
	assert.equal(summary.terminalAgentErrorCount, 1);
	assert.equal(summary.lastAgentStopReason, "error");
	assert.equal(summary.lastAgentErrorMessage, "terminated");
});

test("buildTimeoutDiagnosticsHint formats compact summary", () => {
	const diag: RpcDiagnostics = {
		rawLineCount: 10,
		parsedEventCount: 8,
		parseErrorCount: 2,
		eventCounts: { agent_end: 1, toolcall_start: 3 },
		autoRetryStartCount: 0,
		autoRetryEndCount: 0,
		terminalAgentErrorCount: 0,
		lastAgentStopReason: "end_turn",
		lastAgentErrorMessage: null,
		toolCalls: [],
		anomalies: [],
	};
	const hint = buildTimeoutDiagnosticsHint(diag);
	assert.ok(hint.includes("raw=10"));
	assert.ok(hint.includes("parsed=8"));
	assert.ok(hint.includes("parse_errors=2"));
	assert.ok(hint.includes("last_stop=end_turn"));
});
