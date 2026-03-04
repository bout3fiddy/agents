/**
 * RPC event stream diagnostics tracker.
 *
 * Records tool-call lifecycle events, parse errors, retry counters, and
 * anomalies from the pi RPC stream.  Pure leaf module — no runtime imports.
 */
import { writeFile } from "node:fs/promises";
import type { RpcDiagnostics, RpcToolCallDiagnostics } from "../../data/types.js";

export type RpcToolCallState = {
	id: string;
	toolName: string;
	startCount: number;
	deltaCount: number;
	endCount: number;
	executionStartCount: number;
	executionEndCount: number;
	executionSuccessCount: number;
	executionFailureCount: number;
	maxPartialJsonLength: number;
};

export const createRpcDiagnosticsTracker = () => {
	let rawLineCount = 0;
	let parsedEventCount = 0;
	let parseErrorCount = 0;
	let autoRetryStartCount = 0;
	let autoRetryEndCount = 0;
	let terminalAgentErrorCount = 0;
	let lastAgentStopReason: string | null = null;
	let lastAgentErrorMessage: string | null = null;
	const eventCounts = new Map<string, number>();
	const toolCalls = new Map<string, RpcToolCallState>();

	const incrementEventCount = (eventType: string) => {
		eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
	};

	const toKnownToolName = (value: unknown): string =>
		typeof value === "string" && value.trim().length > 0 ? value.trim() : "unknown";

	const toKnownToolId = (value: unknown, fallbackToolName: string): string => {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
		return `${fallbackToolName}:unknown`;
	};

	const resolveToolCall = (params: { id: string; toolName: string }): RpcToolCallState => {
		const existing = toolCalls.get(params.id);
		if (existing) {
			if (existing.toolName === "unknown" && params.toolName !== "unknown") {
				existing.toolName = params.toolName;
			}
			return existing;
		}
		const created: RpcToolCallState = {
			id: params.id,
			toolName: params.toolName,
			startCount: 0,
			deltaCount: 0,
			endCount: 0,
			executionStartCount: 0,
			executionEndCount: 0,
			executionSuccessCount: 0,
			executionFailureCount: 0,
			maxPartialJsonLength: 0,
		};
		toolCalls.set(params.id, created);
		return created;
	};

	const markToolCallDelta = (params: {
		toolName: unknown;
		toolId: unknown;
		partialJson: unknown;
	}) => {
		const toolName = toKnownToolName(params.toolName);
		const toolId = toKnownToolId(params.toolId, toolName);
		const state = resolveToolCall({ id: toolId, toolName });
		state.deltaCount += 1;
		const partialLen = typeof params.partialJson === "string" ? params.partialJson.length : 0;
		if (partialLen > state.maxPartialJsonLength) state.maxPartialJsonLength = partialLen;
	};

	const markToolCallsFromMessages = (messages: unknown) => {
		if (!Array.isArray(messages)) return;
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			const record = message as Record<string, unknown>;
			if (record.role !== "assistant") continue;
			const content = Array.isArray(record.content) ? record.content : [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const blockRecord = block as Record<string, unknown>;
				if (blockRecord.type !== "toolCall") continue;
				const toolName = toKnownToolName(blockRecord.name);
				const toolId = toKnownToolId(blockRecord.id, toolName);
				const state = resolveToolCall({ id: toolId, toolName });
				const argumentsRecord = blockRecord.arguments as Record<string, unknown> | undefined;
				const contentValue = argumentsRecord?.content;
				if (typeof contentValue === "string" && contentValue.length > state.maxPartialJsonLength) {
					state.maxPartialJsonLength = contentValue.length;
				}
			}
		}
	};

	const recordEvent = (event: Record<string, unknown>) => {
		const type = typeof event.type === "string" ? event.type : "unknown";
		parsedEventCount += 1;
		incrementEventCount(type);
		if (type === "auto_retry_start") autoRetryStartCount += 1;
		if (type === "auto_retry_end") autoRetryEndCount += 1;

		if (type === "toolcall_start") {
			const toolCall = event.toolCall as Record<string, unknown> | undefined;
			const toolName = toKnownToolName(toolCall?.name);
			const toolId = toKnownToolId(toolCall?.id, toolName);
			const state = resolveToolCall({ id: toolId, toolName });
			state.startCount += 1;
		}
		if (type === "toolcall_delta") {
			const toolCall = event.toolCall as Record<string, unknown> | undefined;
			markToolCallDelta({
				toolName: toolCall?.name,
				toolId: toolCall?.id,
				partialJson: event.partialJson,
			});
		}
		if (type === "toolcall_end") {
			const toolCall = event.toolCall as Record<string, unknown> | undefined;
			const toolName = toKnownToolName(toolCall?.name);
			const toolId = toKnownToolId(toolCall?.id, toolName);
			const state = resolveToolCall({ id: toolId, toolName });
			state.endCount += 1;
		}
		if (type === "tool_execution_start") {
			const toolName = toKnownToolName(event.toolName);
			const toolId = toKnownToolId(event.toolCallId, toolName);
			const state = resolveToolCall({ id: toolId, toolName });
			state.executionStartCount += 1;
		}
		if (type === "tool_execution_end") {
			const toolName = toKnownToolName(event.toolName);
			const toolId = toKnownToolId(event.toolCallId, toolName);
			const state = resolveToolCall({ id: toolId, toolName });
			state.executionEndCount += 1;
			if (event.success === false) state.executionFailureCount += 1;
			else state.executionSuccessCount += 1;
		}
		if (type === "message_update") {
			const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent?.type === "toolcall_delta") {
				const partial = assistantEvent.partial as Record<string, unknown> | undefined;
				const content = Array.isArray(partial?.content) ? partial.content : [];
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					const blockRecord = block as Record<string, unknown>;
					if (blockRecord.type !== "toolCall") continue;
					markToolCallDelta({
						toolName: blockRecord.name,
						toolId: blockRecord.id,
						partialJson: blockRecord.partialJson,
					});
				}
			}
		}
		if (type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
			if (lastMessage && typeof lastMessage === "object") {
				const lastRecord = lastMessage as Record<string, unknown>;
				lastAgentStopReason =
					typeof lastRecord.stopReason === "string" ? lastRecord.stopReason : null;
				lastAgentErrorMessage =
					typeof lastRecord.errorMessage === "string" ? lastRecord.errorMessage : null;
				if (lastAgentStopReason === "error") terminalAgentErrorCount += 1;
			}
			markToolCallsFromMessages(messages);
		}
	};

	const recordRawLine = () => {
		rawLineCount += 1;
	};

	const recordParseError = () => {
		parseErrorCount += 1;
	};

	const toSummary = (): RpcDiagnostics => {
		const sortedToolCalls: RpcToolCallDiagnostics[] = Array.from(toolCalls.values()).sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		const anomalies: string[] = [];
		for (const call of sortedToolCalls) {
			const missingCompletion = call.deltaCount > 0 && call.endCount === 0 && call.executionStartCount === 0;
			if (missingCompletion) {
				anomalies.push(
					`incomplete tool call '${call.toolName}' (${call.id}): deltas=${call.deltaCount}, toolcall_end=0, execution_start=0, max_partial_json_len=${call.maxPartialJsonLength}`,
				);
				continue;
			}
			if (call.executionStartCount > call.executionEndCount) {
				anomalies.push(
					`hung tool execution '${call.toolName}' (${call.id}): execution_start=${call.executionStartCount}, execution_end=${call.executionEndCount}`,
				);
			}
		}
		return {
			rawLineCount,
			parsedEventCount,
			parseErrorCount,
			eventCounts: Object.fromEntries(eventCounts.entries()),
			autoRetryStartCount,
			autoRetryEndCount,
			terminalAgentErrorCount,
			lastAgentStopReason,
			lastAgentErrorMessage,
			toolCalls: sortedToolCalls,
			anomalies,
		};
	};

	return {
		recordRawLine,
		recordParseError,
		recordEvent,
		toSummary,
	};
};

export const buildTimeoutDiagnosticsHint = (diagnostics: RpcDiagnostics): string => {
	const topEvents = Object.entries(diagnostics.eventCounts)
		.sort((left, right) => right[1] - left[1])
		.slice(0, 4)
		.map(([type, count]) => `${type}:${count}`)
		.join(", ");
	const incompleteCalls = diagnostics.toolCalls
		.filter((call) => call.deltaCount > 0 && call.endCount === 0 && call.executionStartCount === 0)
		.map((call) => `${call.toolName}:${call.id}`)
		.slice(0, 2)
		.join(", ");
	const hintParts = [
		`raw=${diagnostics.rawLineCount}`,
		`parsed=${diagnostics.parsedEventCount}`,
		`parse_errors=${diagnostics.parseErrorCount}`,
		`last_stop=${diagnostics.lastAgentStopReason ?? "none"}`,
		`last_error=${diagnostics.lastAgentErrorMessage ?? "none"}`,
		`events=[${topEvents || "none"}]`,
	];
	if (incompleteCalls.length > 0) hintParts.push(`incomplete_calls=[${incompleteCalls}]`);
	return ` rpc diagnostics: ${hintParts.join(" ")}`;
};

export const persistRpcDiagnostics = async (
	diagnosticsPath: string | null,
	diagnostics: RpcDiagnostics,
): Promise<void> => {
	if (!diagnosticsPath) return;
	await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2)).catch(() => undefined);
};
