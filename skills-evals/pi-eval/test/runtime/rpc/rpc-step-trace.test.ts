import assert from "node:assert/strict";
import test from "node:test";
import { createRpcStepTraceCollector } from "../../../src/runtime/rpc/rpc-step-trace.js";

test("createRpcStepTraceCollector strips encrypted reasoning and summarizes tool steps", () => {
	const collector = createRpcStepTraceCollector(20);
	collector.onLine(JSON.stringify({ type: "turn_start" }));
	collector.onLine(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinkingSignature: "{\"encrypted_content\":\"secret\"}" },
				{ type: "toolCall", name: "read", arguments: { path: "/workspace/src/main.zig" } },
			],
		},
	}));
	collector.onLine(JSON.stringify({
		type: "tool_execution_end",
		toolName: "read",
		result: { content: [{ type: "text", text: "hello world" }] },
	}));
	collector.onLine(JSON.stringify({
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "stop" }],
	}));

	const summary = collector.toSummary().join("\n");
	assert.match(summary, /\[tool-call\] read path=\/workspace\/src\/main\.zig/);
	assert.match(summary, /\[tool-end\] read ok result_text_bytes=11/);
	assert.doesNotMatch(summary, /secret/);
	assert.doesNotMatch(summary, /encrypted_content/);
});
