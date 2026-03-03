import type { TokenUsage } from "../data/types.js";

export const collectAssistantText = (messages: unknown[]): string => {
	const chunks: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const content = Array.isArray(record.content) ? record.content : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const blockRecord = block as Record<string, unknown>;
			if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
				chunks.push(blockRecord.text);
			}
		}
	}
	return chunks.join("\n").trim();
};

export const sumUsageFromMessages = (messages: unknown[]): TokenUsage => {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const usage = record.usage as Record<string, number> | undefined;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		totalTokens +=
			usage.totalTokens ??
			(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	}
	return { input, output, cacheRead, cacheWrite, totalTokens };
};
