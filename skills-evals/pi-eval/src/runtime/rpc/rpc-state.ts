/**
 * RPC connection state machine.
 *
 * Manages agent_end resolution, retry settle timers, and prompt error
 * tracking for a single case process.
 */
import type { RpcDiagnostics } from "../../data/types.js";
import { createRpcDiagnosticsTracker } from "./rpc-diagnostics.js";
import { extractTerminalErrorFromMessages } from "./rpc-messages.js";

// RPC/case-level retry settle window (1.5s). See also RETRYABLE_TERMINATION_SETTLE_MS
// in worker.ts (3s) which operates at the prompt/turn level.
const RETRYABLE_AGENT_END_SETTLE_MS = 1_500;

export type RpcState = {
	promptError: string | null;
	waitForAgentEnd: () => Promise<void>;
	onLine: (line: string) => void;
	diagnostics: () => RpcDiagnostics;
	dispose: () => void;
};

export const createRpcState = (onRawLine?: (line: string) => void): RpcState => {
	const pendingResolvers: Array<() => void> = [];
	let pendingAgentEnds = 0;
	let promptError: string | null = null;
	let retryableAgentEndTimer: NodeJS.Timeout | null = null;
	const diagnostics = createRpcDiagnosticsTracker();

	const clearRetryableAgentEndTimer = () => {
		if (!retryableAgentEndTimer) return;
		clearTimeout(retryableAgentEndTimer);
		retryableAgentEndTimer = null;
	};

	const resolveAgentEnd = () => {
		const resolve = pendingResolvers.shift();
		if (resolve) resolve();
		else pendingAgentEnds += 1;
	};

	const waitForAgentEnd = () =>
		new Promise<void>((resolve) => {
			if (pendingAgentEnds > 0) {
				pendingAgentEnds -= 1;
				resolve();
				return;
			}
			pendingResolvers.push(resolve);
		});

	const scheduleRetryableAgentEnd = (terminalError: string | null) => {
		clearRetryableAgentEndTimer();
		retryableAgentEndTimer = setTimeout(() => {
			retryableAgentEndTimer = null;
			if (!promptError && terminalError) promptError = terminalError;
			resolveAgentEnd();
		}, RETRYABLE_AGENT_END_SETTLE_MS);
	};

	const onLine = (line: string) => {
		diagnostics.recordRawLine();
		onRawLine?.(line);
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			diagnostics.recordParseError();
			return;
		}
		diagnostics.recordEvent(event);
		if (event.type === "response" && event.command === "prompt" && event.success === false) {
			promptError = event.error ?? "prompt rejected";
		}
		if (event.type === "auto_retry_start") {
			clearRetryableAgentEndTimer();
			return;
		}
		if (event.type === "auto_retry_end") {
			clearRetryableAgentEndTimer();
			if (event.success === false) {
				const finalError = typeof event.finalError === "string" && event.finalError.trim().length > 0
					? event.finalError.trim()
					: "terminated";
				if (!promptError) promptError = finalError;
				resolveAgentEnd();
			}
			return;
		}
		if (event.type !== "agent_end") return;
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
		const terminalError = messages.length > 0 ? extractTerminalErrorFromMessages(messages) : null;
		const shouldDeferAgentEndForRetryWindow = Boolean(
			lastMessage &&
			typeof lastMessage === "object" &&
			(lastMessage as Record<string, unknown>).role === "assistant" &&
			(lastMessage as Record<string, unknown>).stopReason === "error",
		);
		if (shouldDeferAgentEndForRetryWindow) {
			scheduleRetryableAgentEnd(terminalError ?? "terminated");
			return;
		}
		clearRetryableAgentEndTimer();
		resolveAgentEnd();
	};

	return {
		get promptError() {
			return promptError;
		},
		waitForAgentEnd,
		onLine,
		diagnostics: () => diagnostics.toSummary(),
		dispose: () => {
			clearRetryableAgentEndTimer();
			while (pendingResolvers.length > 0) {
				const resolve = pendingResolvers.shift();
				resolve?.();
			}
		},
	};
};
