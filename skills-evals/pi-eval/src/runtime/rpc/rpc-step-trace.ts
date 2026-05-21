const DEFAULT_MAX_STEPS = 80;
const DEFAULT_MAX_TEXT = 220;

const compactWhitespace = (value: string): string =>
	value.replace(/\s+/g, " ").trim();

const truncate = (value: string, max = DEFAULT_MAX_TEXT): string => {
	const compact = compactWhitespace(value);
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(0, max - 3))}...`;
};

const textBytes = (value: unknown): number =>
	typeof value === "string" ? Buffer.byteLength(value, "utf-8") : 0;

const summarizeToolArguments = (toolName: string, args: unknown): string => {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const path = typeof record.path === "string" ? record.path : null;
	if (toolName === "read" && path) return `path=${path}`;
	if (toolName === "bash") {
		const command =
			typeof record.command === "string" ? record.command :
				typeof record.cmd === "string" ? record.cmd :
					typeof record.input === "string" ? record.input :
						"";
		return command ? `cmd=${truncate(command, 360)}` : "";
	}
	if (toolName === "write") {
		const bytes = textBytes(record.content);
		return `${path ? `path=${path} ` : ""}content_bytes=${bytes}`.trim();
	}
	if (toolName === "edit") {
		const edits = Array.isArray(record.edits) ? record.edits : [];
		return `${path ? `path=${path} ` : ""}edits=${edits.length}`.trim();
	}
	const keys = Object.keys(record).slice(0, 4);
	return keys.length > 0 ? `args=${keys.join(",")}` : "";
};

const summarizeToolResult = (toolName: string, result: unknown): string => {
	if (!result || typeof result !== "object") return "";
	const record = result as Record<string, unknown>;
	if (Array.isArray(record.content)) {
		let bytes = 0;
		const textSnippets: string[] = [];
		for (const block of record.content) {
			if (!block || typeof block !== "object") continue;
			const text = (block as Record<string, unknown>).text;
			bytes += textBytes(text);
			if (toolName === "bash" && typeof text === "string" && text.trim().length > 0) {
				textSnippets.push(truncate(text, 260));
			}
		}
		const snippet = textSnippets.length > 0 ? ` text=${textSnippets.slice(0, 2).join(" | ")}` : "";
		return `result_text_bytes=${bytes}${snippet}`;
	}
	const keys = Object.keys(record).slice(0, 4);
	return keys.length > 0 ? `result_keys=${keys.join(",")}` : "";
};

const collectAssistantBlocks = (message: unknown): string[] => {
	if (!message || typeof message !== "object") return [];
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return [];
	const content = Array.isArray(record.content) ? record.content : [];
	const entries: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const blockRecord = block as Record<string, unknown>;
		if (blockRecord.type === "thinking") continue;
		if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
			const text = truncate(blockRecord.text);
			if (text.length > 0) entries.push(`[assistant] ${text}`);
		}
		if (blockRecord.type === "toolCall") {
			const toolName = typeof blockRecord.name === "string" ? blockRecord.name : "unknown";
			const args = summarizeToolArguments(toolName, blockRecord.arguments);
			entries.push(`[tool-call] ${toolName}${args ? ` ${args}` : ""}`);
		}
	}
	return entries;
};

export const createRpcStepTraceCollector = (maxSteps = DEFAULT_MAX_STEPS) => {
	const steps: string[] = [];
	let omitted = 0;

	const push = (entry: string) => {
		if (entry.trim().length === 0) return;
		if (steps.length < maxSteps) {
			steps.push(entry);
		} else {
			omitted += 1;
		}
	};

	const onLine = (line: string) => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			push("[rpc] non-json line omitted");
			return;
		}

		if (event.type === "turn_start") push("[turn] start");
		if (event.type === "turn_end") push("[turn] end");
		if (event.type === "response" && event.success === false) {
			const error = typeof event.error === "string" ? event.error : "unknown";
			push(`[prompt-error] ${truncate(error)}`);
		}
		if (event.type === "message_end") {
			const message = event.message as Record<string, unknown> | undefined;
			for (const entry of collectAssistantBlocks(message)) push(entry);
		}
		if (event.type === "tool_execution_start") {
			const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
			const args = summarizeToolArguments(toolName, event.args);
			push(`[tool-start] ${toolName}${args ? ` ${args}` : ""}`);
		}
		if (event.type === "tool_execution_end") {
			const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
			const ok = event.success === false ? "fail" : "ok";
			const result = summarizeToolResult(toolName, event.result);
			const error = typeof event.error === "string" ? ` error=${truncate(event.error)}` : "";
			push(`[tool-end] ${toolName} ${ok}${result ? ` ${result}` : ""}${error}`);
		}
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			const last = messages.length > 0 ? messages[messages.length - 1] : null;
			if (last && typeof last === "object") {
				const record = last as Record<string, unknown>;
				const stop = typeof record.stopReason === "string" ? record.stopReason : "unknown";
				const error = typeof record.errorMessage === "string" ? ` error=${truncate(record.errorMessage)}` : "";
				push(`[agent-end] stop=${stop}${error}`);
			} else {
				push("[agent-end]");
			}
		}
	};

	const toSummary = (): string[] => {
		if (omitted === 0) return [...steps];
		return [...steps, `[trace] ${omitted} additional sanitized step(s) omitted`];
	};

	return { onLine, toSummary };
};
