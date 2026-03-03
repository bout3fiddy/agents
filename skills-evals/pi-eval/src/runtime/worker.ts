import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import {
	access as fsAccess,
	readdir as fsReadDir,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	captureReadAttempt,
	captureReadDenied,
	captureReadInvocation,
	captureReadSize,
	isReferencePath,
	isSkillPath,
	serializeReadCapture,
	type ReadCapture,
} from "./capture.js";
import { modelSpecFromModel } from "./model-registry.js";
import type { CaseRunResult, ReadBreakdownEntry, TokenUsage, ToolUsageSummary } from "../data/types.js";
import { assertReadablePath, createPathDenyPolicy, type PathDenyPolicy } from "./read-policy.js";
import { ensureDir } from "../data/utils.js";
import { parseWorkerRuntimeConfig } from "./worker-contract.js";
import {
	FORBIDDEN_WORKSPACE_VIOLATION,
	assertWithinSandboxBoundary,
	createSandboxBoundary,
	wrapToolWithSandboxBoundary,
	type SandboxBoundary,
	type ToolWithExecute,
} from "./sandbox-boundary.js";

const DRY_RUN_SKILL_STUB = "Dry-run mode: file content unavailable.";
const RETRYABLE_TERMINATION_SETTLE_MS = 3_000;

const collectAssistantText = (messages: Array<AssistantMessage | ToolResultMessage>): string => {
	const chunks: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content ?? []) {
			if (block && typeof block === "object" && "type" in block && block.type === "text") {
				const text = "text" in block ? block.text : "";
				if (typeof text === "string") chunks.push(text);
			}
		}
	}
	return chunks.join("\n").trim();
};

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

const extractTerminalError = (messages: Array<AssistantMessage | ToolResultMessage>): string => {
	const lastAssistant = getLastAssistantMessage(messages);
	if (!lastAssistant || typeof lastAssistant.errorMessage !== "string") return "terminated";
	const trimmed = lastAssistant.errorMessage.trim();
	return trimmed.length > 0 ? trimmed : "terminated";
};

const sumUsage = (messages: Array<AssistantMessage | ToolResultMessage>): TokenUsage => {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cacheRead += message.usage?.cacheRead ?? 0;
		cacheWrite += message.usage?.cacheWrite ?? 0;
		totalTokens += message.usage?.totalTokens ??
			(message.usage?.input ?? 0) +
			(message.usage?.output ?? 0) +
			(message.usage?.cacheRead ?? 0) +
			(message.usage?.cacheWrite ?? 0);
	}
	return { input, output, cacheRead, cacheWrite, totalTokens };
};

const adaptToolExecute = <T extends ToolWithExecute>(tool: T): T => ({
	...tool,
	execute: (toolCallId: string, args: Record<string, unknown>) =>
		tool.execute(toolCallId, args, undefined),
});

const createEvalReadTool = async (
	cwd: string,
	agentDir: string,
	dryRunEnabled: boolean,
	readDenyPaths: string[],
	boundary: SandboxBoundary,
	readCapture: ReadCapture,
) => {
	const denyPolicy = await createPathDenyPolicy(cwd, readDenyPaths);
	const base = createReadTool(cwd, {
		operations: {
			access: async (absolutePath: string) => {
				captureReadAttempt(absolutePath, agentDir, readCapture);
				try {
					await assertWithinSandboxBoundary(absolutePath, boundary);
					await assertReadablePath(absolutePath, denyPolicy);
					if (dryRunEnabled && isSkillPath(absolutePath)) {
						captureReadInvocation(absolutePath, agentDir, readCapture);
						return;
					}
					await fsAccess(absolutePath, constants.R_OK);
					captureReadInvocation(absolutePath, agentDir, readCapture);
				} catch (error) {
					captureReadDenied(absolutePath, agentDir, readCapture);
					throw error;
				}
			},
			readFile: async (absolutePath: string) => {
				captureReadAttempt(absolutePath, agentDir, readCapture);
				try {
					await assertWithinSandboxBoundary(absolutePath, boundary);
						await assertReadablePath(absolutePath, denyPolicy);
						if (dryRunEnabled && isSkillPath(absolutePath)) {
							captureReadInvocation(absolutePath, agentDir, readCapture);
							const stub = Buffer.from(DRY_RUN_SKILL_STUB);
							captureReadSize(absolutePath, stub.length, readCapture);
							return stub;
						}
						const stat = await fsStat(absolutePath);
						if (stat.isDirectory()) {
							const entries = await fsReadDir(absolutePath, { withFileTypes: true });
							const listing = entries
								.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
								.sort((left, right) => left.localeCompare(right))
								.join("\n");
							captureReadInvocation(absolutePath, agentDir, readCapture);
							const listingBuf = Buffer.from(listing);
							captureReadSize(absolutePath, listingBuf.length, readCapture);
							return listingBuf;
						}
						const content = await fsReadFile(absolutePath);
						captureReadInvocation(absolutePath, agentDir, readCapture);
						captureReadSize(absolutePath, content.length, readCapture);
						return content;
				} catch (error) {
					captureReadDenied(absolutePath, agentDir, readCapture);
					throw error;
				}
			},
		},
	});

	return { denyPolicy, tool: adaptToolExecute(base) };
};

const createReadCapture = (): ReadCapture => ({
	skillAttempts: new Set<string>(),
	skillInvocations: new Set<string>(),
	skillDenied: new Set<string>(),
	skillFileAttempts: new Set<string>(),
	skillFileInvocations: new Set<string>(),
	skillFileDenied: new Set<string>(),
	refAttempts: new Set<string>(),
	refInvocations: new Set<string>(),
	refDenied: new Set<string>(),
	readSizes: new Map<string, number>(),
});

const isSuccessfulToolResultEvent = (event: Record<string, unknown>): boolean => {
	if (typeof event.success === "boolean") return event.success;
	if ("error" in event && event.error) return false;
	return true;
};

const extractToolPath = (input: unknown): string | null => {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "filePath", "targetPath", "file", "target"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
};

const registerReadCaptureHooks = (
	pi: ExtensionAPI,
	agentDir: string,
	readCapture: ReadCapture,
	toolFailures: Set<string>,
	toolUsage: ToolUsageCapture,
): void => {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		captureReadAttempt(path.resolve(ctx.cwd, rawPath), agentDir, readCapture);
		return undefined;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write") toolUsage.writeCalls += 1;
		if (event.toolName === "edit") toolUsage.editCalls += 1;
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		const absolutePath = path.resolve(ctx.cwd, rawPath);
		if (isSuccessfulToolResultEvent(event as unknown as Record<string, unknown>)) {
			captureReadInvocation(absolutePath, agentDir, readCapture);
		} else {
			captureReadDenied(absolutePath, agentDir, readCapture);
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const eventRecord = event as unknown as Record<string, unknown>;
		if (isSuccessfulToolResultEvent(eventRecord)) return undefined;
		if (event.toolName === "write") toolUsage.writeFailures += 1;
		if (event.toolName === "edit") toolUsage.editFailures += 1;
		const toolPath = extractToolPath(event.input);
		const rawError = eventRecord.error;
		const message = typeof rawError === "string" && rawError.trim().length > 0
			? rawError.trim()
			: "tool returned an unknown error";
		const location = toolPath ? ` (${toolPath})` : "";
		toolFailures.add(`${event.toolName} tool failed${location}: ${message}`);
		return undefined;
	});
};

type WorkerAccumulator = {
	outputChunks: string[];
	tokenTotals: TokenUsage;
	completedTurns: number;
	finalized: boolean;
};

type ToolUsageCapture = ToolUsageSummary;

const createAccumulator = (): WorkerAccumulator => ({
	outputChunks: [],
	tokenTotals: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	},
	completedTurns: 0,
	finalized: false,
});

const createToolUsageCapture = (allowedTools: Set<string>): ToolUsageCapture => ({
	allowedTools: Array.from(allowedTools).sort(),
	writeCalls: 0,
	editCalls: 0,
	writeFailures: 0,
	editFailures: 0,
});

const appendAgentEnd = (
	acc: WorkerAccumulator,
	messages: Array<AssistantMessage | ToolResultMessage>,
	countTurn = true,
): void => {
	const outputText = collectAssistantText(messages);
	if (outputText) acc.outputChunks.push(outputText);
	const usage = sumUsage(messages);
	acc.tokenTotals.input += usage.input;
	acc.tokenTotals.output += usage.output;
	acc.tokenTotals.cacheRead += usage.cacheRead;
	acc.tokenTotals.cacheWrite += usage.cacheWrite;
	acc.tokenTotals.totalTokens += usage.totalTokens;
	if (countTurn) acc.completedTurns += 1;
};

const shouldFinalize = (acc: WorkerAccumulator, expectedTurns: number, force = false): boolean => {
	if (acc.finalized) return false;
	if (!force && acc.completedTurns < expectedTurns) return false;
	acc.finalized = true;
	return true;
};

const buildReadBreakdown = (readCapture: ReadCapture): ReadBreakdownEntry[] => {
	const entries: ReadBreakdownEntry[] = [];
	for (const [filePath, bytes] of readCapture.readSizes) {
		let category: ReadBreakdownEntry["category"] = "task";
		if (isSkillPath(filePath)) category = "skill";
		else if (isReferencePath(filePath)) category = "ref";
		entries.push({
			path: filePath,
			category,
			bytes,
			estTokens: Math.ceil(bytes / 4),
		});
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
};

const buildResult = (params: {
	caseId: string;
	dryRun: boolean;
	bootstrapProfile: "full_payload" | "no_payload";
	availableSkills: string[];
	bootstrapManifestHash: string | null;
	readCapture: ReadCapture;
	denyPolicy: PathDenyPolicy | null;
	sandboxBoundary: SandboxBoundary;
	toolFailures: Set<string>;
	toolUsage: ToolUsageCapture;
	acc: WorkerAccumulator;
	startedAt: number;
	model: any;
}): CaseRunResult => {
	const {
		caseId,
		dryRun,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash,
		readCapture,
		denyPolicy,
		sandboxBoundary,
		toolFailures,
		toolUsage,
		acc,
		startedAt,
		model,
	} = params;
	const capturedReads = serializeReadCapture(readCapture);
	const deniedReadErrors = denyPolicy
		? Array.from(denyPolicy.deniedReads).sort().map((entry) => `forbidden read: ${entry}`)
		: [];
	const boundaryErrors = Array.from(sandboxBoundary.violations)
		.sort()
		.map((entry) => `${FORBIDDEN_WORKSPACE_VIOLATION}: ${entry}`);
	const toolFailureErrors = Array.from(toolFailures).sort();
	const errors = [...boundaryErrors, ...deniedReadErrors, ...toolFailureErrors];
	if (bootstrapProfile === "no_payload" && errors.length > 0) {
		errors.unshift("policy deny triggered in no_payload profile");
	}

	return {
		caseId,
		dryRun,
		model: model ? modelSpecFromModel(model) : null,
		workerReady: true,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash,
		skillInvocations: capturedReads.skillInvocations,
		skillAttempts: capturedReads.skillAttempts,
		skillDenied: capturedReads.skillDenied,
		skillFileInvocations: capturedReads.skillFileInvocations,
		skillFileAttempts: capturedReads.skillFileAttempts,
		skillFileDenied: capturedReads.skillFileDenied,
		refInvocations: capturedReads.refInvocations,
		refAttempts: capturedReads.refAttempts,
		refDenied: capturedReads.refDenied,
		outputText: acc.outputChunks.join("\n").trim(),
		tokens: acc.tokenTotals,
		durationMs: Date.now() - startedAt,
		errors,
		toolUsage,
		readBreakdown: buildReadBreakdown(readCapture),
	};
};

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
