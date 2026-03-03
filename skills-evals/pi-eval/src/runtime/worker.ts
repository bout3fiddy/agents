import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PathDenyPolicy } from "./read-policy.js";
import { ensureDir } from "../data/utils.js";
import { extractTerminalErrorFromMessages } from "./rpc-messages.js";
import { parseWorkerRuntimeConfig } from "./worker-contract.js";
import {
	createSandboxBoundary,
	wrapToolWithSandboxBoundary,
} from "./sandbox-boundary.js";
import {
	createAccumulator,
	createToolUsageCapture,
	appendAgentEnd,
	shouldFinalize,
	buildResult,
} from "./worker-accumulator.js";
import {
	adaptToolExecute,
	createEvalReadTool,
	createReadCapture,
	registerReadCaptureHooks,
} from "./worker-tools.js";

// Prompt-level retry settle window (3s). See also RETRYABLE_AGENT_END_SETTLE_MS
// in case-process.ts (1.5s) which operates at the RPC/case level.
const RETRYABLE_TERMINATION_SETTLE_MS = 3_000;

// ── Retryable termination helpers ────────────────────────────────────────

const getLastAssistantMessage = (
	messages: Array<AssistantMessage | ToolResultMessage>,
): AssistantMessage | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return null;
};

const isRetryableTermination = (
	messages: Array<AssistantMessage | ToolResultMessage>,
): boolean => {
	const lastAssistant = getLastAssistantMessage(messages);
	return Boolean(
		lastAssistant &&
		lastAssistant.stopReason === "error" &&
		lastAssistant.errorMessage === "terminated",
	);
};

/** Delegates to shared extractTerminalErrorFromMessages (rpc-messages.ts). */
const extractTerminalError = (messages: Array<AssistantMessage | ToolResultMessage>): string =>
	extractTerminalErrorFromMessages(messages as unknown[]);

// ── Worker registration ──────────────────────────────────────────────────

export const registerEvalWorker = async (pi: ExtensionAPI): Promise<boolean> => {
	const cwd = process.cwd();
	const config = parseWorkerRuntimeConfig(process.env, cwd);
	if (!config) return false;

	const sandboxBoundary = await createSandboxBoundary(cwd, config.agentDir);
	const readCapture = createReadCapture();
	let denyPolicy: PathDenyPolicy | null = null;
	if (config.allowedTools.has("read")) {
		const readSetup = await createEvalReadTool(
			cwd,
			config.agentDir,
			config.dryRun,
			config.readDenyPaths,
			sandboxBoundary,
			readCapture,
		);
		denyPolicy = readSetup.denyPolicy;
		pi.registerTool(readSetup.tool);
	}
	if (config.allowedTools.has("edit")) {
		pi.registerTool(
			wrapToolWithSandboxBoundary(adaptToolExecute(createEditTool(cwd)), sandboxBoundary),
		);
	}
	if (config.allowedTools.has("write")) {
		pi.registerTool(
			wrapToolWithSandboxBoundary(adaptToolExecute(createWriteTool(cwd)), sandboxBoundary),
		);
	}

	const startedAt = Date.now();
	const acc = createAccumulator();
	const toolFailures = new Set<string>();
	const toolUsage = createToolUsageCapture(config.allowedTools);
	registerReadCaptureHooks(pi, config.agentDir, readCapture, toolFailures, toolUsage);
	type WorkerEventCtx = { model: unknown; shutdown: () => void };
	const extensionPi = pi as unknown as {
		on: (
			eventName: string,
			handler: (event: Record<string, unknown>, ctx: WorkerEventCtx) => Promise<void> | void,
		) => void;
	};
	let retryableFinalizeTimer: NodeJS.Timeout | null = null;
	const clearRetryableFinalizeTimer = () => {
		if (!retryableFinalizeTimer) return;
		clearTimeout(retryableFinalizeTimer);
		retryableFinalizeTimer = null;
	};

	const persistResult = async (ctx: WorkerEventCtx, terminalError?: string) => {
		clearRetryableFinalizeTimer();
		const result = buildResult({
			caseId: config.caseId,
			dryRun: config.dryRun,
			bootstrapProfile: config.bootstrapProfile,
			availableSkills: config.availableSkills,
			bootstrapManifestHash: config.bootstrapManifestHash,
			readCapture,
			denyPolicy,
			sandboxBoundary,
			toolFailures,
			toolUsage,
			acc,
			startedAt,
			model: ctx.model,
		});
		if (terminalError && terminalError.trim().length > 0) {
			result.errors.push(`worker terminal error: ${terminalError.trim()}`);
		}
		await ensureDir(path.dirname(config.outputPath));
		await writeFile(config.outputPath, JSON.stringify(result, null, 2));
		ctx.shutdown();
	};

	const scheduleRetryableFinalize = (ctx: WorkerEventCtx, terminalError: string) => {
		clearRetryableFinalizeTimer();
		retryableFinalizeTimer = setTimeout(() => {
			retryableFinalizeTimer = null;
			if (!shouldFinalize(acc, config.expectedTurns, true)) return;
			void persistResult(ctx, terminalError).catch(() => undefined);
		}, RETRYABLE_TERMINATION_SETTLE_MS);
	};

	pi.on("agent_end", async (event, ctx) => {
		const messages = Array.isArray(event.messages)
			? (event.messages as Array<AssistantMessage | ToolResultMessage>)
			: [];
		const retryableTermination = isRetryableTermination(messages);
		appendAgentEnd(acc, messages, !retryableTermination);
		if (retryableTermination) {
			scheduleRetryableFinalize(ctx, extractTerminalError(messages));
			return;
		}
		clearRetryableFinalizeTimer();
		if (!shouldFinalize(acc, config.expectedTurns)) return;
		await persistResult(ctx);
	});

	extensionPi.on("agent_start", () => {
		clearRetryableFinalizeTimer();
	});

	extensionPi.on("auto_retry_start", () => {
		clearRetryableFinalizeTimer();
	});

	extensionPi.on("auto_retry_end", async (event, ctx) => {
		clearRetryableFinalizeTimer();
		if (event.success === true) return;
		if (event.success !== false) return;
		const terminalError = typeof event.finalError === "string" && event.finalError.trim().length > 0
			? event.finalError.trim()
			: "terminated";
		if (!shouldFinalize(acc, config.expectedTurns, true)) return;
		await persistResult(ctx, terminalError);
	});

	return true;
};
