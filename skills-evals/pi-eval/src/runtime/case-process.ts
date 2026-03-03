import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
	BootstrapProfile,
	CaseRunResult,
	EvalCase,
	ModelSpec,
	RpcDiagnostics,
	RpcToolCallDiagnostics,
} from "../data/types.js";
import {
	fileExists,
	isPathInsideRoot as isPathInside,
	parsePositiveInt,
	sleep,
	withTimeout,
} from "../data/utils.js";
import { buildWorkerEnv } from "./worker-contract.js";
import { toSafePathSegment } from "./path-safety.js";
import {
	createMandatorySandboxEngine,
	type SandboxEngine,
} from "./sandbox-engine.js";

const DEFAULT_CASE_TIMEOUT_MS = 300_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const RETRYABLE_AGENT_END_SETTLE_MS = 1_500;
export const GUEST_WORKSPACE_DIR = "/workspace";
export const GUEST_HOME_DIR = "/home/sandbox";
const GUEST_OUTPUT_DIR = "/tmp/pi-eval-out";

type RpcState = {
	promptError: string | null;
	waitForAgentEnd: () => Promise<void>;
	onLine: (line: string) => void;
	diagnostics: () => RpcDiagnostics;
	dispose: () => void;
};

type RpcToolCallState = {
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

const parsePositiveIntEnv = (name: string, fallback: number): number =>
	parsePositiveInt(process.env[name], fallback);

const waitForFile = async (filePath: string, timeoutMs = 10_000, intervalMs = 250): Promise<boolean> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await fileExists(filePath)) return true;
		await sleep(intervalMs);
	}
	return false;
};

const normalizePosixRelative = (relativePath: string): string =>
	relativePath.split(path.sep).join("/");

const hostPathToGuest = (
	hostPath: string,
	hostRoot: string,
	guestRoot: string,
): string => {
	const absoluteHostPath = path.resolve(hostPath);
	const absoluteHostRoot = path.resolve(hostRoot);
	if (!isPathInside(absoluteHostPath, absoluteHostRoot)) {
		throw new Error(
			`path '${absoluteHostPath}' is outside sandbox workspace '${absoluteHostRoot}'`,
		);
	}
	const relative = normalizePosixRelative(path.relative(absoluteHostRoot, absoluteHostPath));
	if (!relative || relative === ".") return guestRoot;
	return `${guestRoot}/${relative}`;
};

const mapReadDenyPathsToGuest = (params: {
	readDenyPaths: string[];
	sandboxWorkspaceDir: string;
	sandboxHomeDir?: string;
}): string[] => {
	const { readDenyPaths, sandboxWorkspaceDir, sandboxHomeDir } = params;
	const guestPaths = new Set<string>();
	for (const denyPath of readDenyPaths) {
		const resolved = path.isAbsolute(denyPath)
			? path.resolve(denyPath)
			: path.resolve(sandboxWorkspaceDir, denyPath);
		if (isPathInside(resolved, sandboxWorkspaceDir)) {
			guestPaths.add(hostPathToGuest(resolved, sandboxWorkspaceDir, GUEST_WORKSPACE_DIR));
			continue;
		}
		if (sandboxHomeDir && isPathInside(resolved, sandboxHomeDir)) {
			guestPaths.add(hostPathToGuest(resolved, sandboxHomeDir, GUEST_HOME_DIR));
			continue;
		}
		throw new Error(
			`read deny path '${denyPath}' resolves outside sandbox workspace/home: ${resolved}`,
		);
	}
	return Array.from(guestPaths);
};

const createRpcDiagnosticsTracker = () => {
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

const createRpcState = (onRawLine?: (line: string) => void): RpcState => {
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
		const terminalError = (() => {
			if (!lastMessage || typeof lastMessage !== "object") return null;
			const rawError = (lastMessage as Record<string, unknown>).errorMessage;
			if (typeof rawError !== "string") return null;
			const trimmed = rawError.trim();
			return trimmed.length > 0 ? trimmed : null;
		})();
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

const buildWorkerArgs = (
	model: ModelSpec,
	thinkingLevel: string,
	tools: string[],
	extensionEntry: string,
): string[] => [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionEntry,
		"--tools",
		tools.join(","),
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--thinking",
		thinkingLevel,
	];

export const buildStubResult = (caseId: string, dryRun: boolean, errors: string[]): CaseRunResult => ({
	caseId,
	dryRun,
	model: null,
	skillInvocations: [],
	skillAttempts: [],
	refInvocations: [],
	refAttempts: [],
	outputText: "",
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	durationMs: 0,
	errors,
	workspaceDir: null,
});

const collectWorkerResult = async (params: {
	outputPath: string;
	evalCase: EvalCase;
	dryRun: boolean;
	stderrChunks: string[];
	promptError: string | null;
}): Promise<CaseRunResult> => {
	const { outputPath, evalCase, dryRun, stderrChunks, promptError } = params;
	const outputReady = await waitForFile(outputPath, 15_000);
	const stderrLines = stderrChunks.map((line) => line.trim()).filter(Boolean);
	if (!outputReady) {
		return buildStubResult(evalCase.id, dryRun, [promptError ?? "no output from worker", ...stderrLines]);
	}
	const raw = await readFile(outputPath, "utf-8");
	const result = JSON.parse(raw) as CaseRunResult;
	if (result.workerReady !== true) {
		return buildStubResult(evalCase.id, dryRun, [
			"eval worker extension handshake missing",
			...stderrLines,
		]);
	}
	if (promptError) result.errors.push(promptError);
	if (stderrLines.length > 0) result.errors.push(...stderrLines);
	return result;
};

const pushUniqueError = (errors: string[], message: string) => {
	if (!errors.includes(message)) errors.push(message);
};

const attachRpcDiagnostics = (result: CaseRunResult, diagnostics: RpcDiagnostics) => {
	result.rpcDiagnostics = diagnostics;
	if (diagnostics.parseErrorCount > 0) {
		pushUniqueError(
			result.errors,
			`rpc diagnostics: ${diagnostics.parseErrorCount} non-JSON line(s) in RPC stream`,
		);
	}
	const maxDetailedAnomalies = 3;
	for (const anomaly of diagnostics.anomalies.slice(0, maxDetailedAnomalies)) {
		pushUniqueError(result.errors, `rpc diagnostics: ${anomaly}`);
	}
	if (diagnostics.anomalies.length > maxDetailedAnomalies) {
		pushUniqueError(
			result.errors,
			`rpc diagnostics: ${diagnostics.anomalies.length - maxDetailedAnomalies} additional anomaly/anomalies omitted`,
		);
	}
};

const persistRpcDiagnostics = async (
	diagnosticsPath: string | null,
	diagnostics: RpcDiagnostics,
): Promise<void> => {
	if (!diagnosticsPath) return;
	await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2)).catch(() => undefined);
};

const buildTimeoutDiagnosticsHint = (diagnostics: RpcDiagnostics): string => {
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

export const runCaseProcess = async (params: {
	evalCase: EvalCase;
	model: ModelSpec;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	extensionEntry: string;
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string | null;
	readDenyPaths: string[];
	homeDir?: string;
	sandboxEngine?: SandboxEngine;
}): Promise<CaseRunResult> => {
	const {
		evalCase,
		model,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		extensionEntry,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash,
		readDenyPaths,
		homeDir,
		sandboxEngine,
	} = params;
	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const caseTimeoutMs = parsePositiveIntEnv("PI_EVAL_CASE_TIMEOUT_MS", DEFAULT_CASE_TIMEOUT_MS);
	const shutdownTimeoutMs = parsePositiveIntEnv(
		"PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS",
		DEFAULT_SHUTDOWN_TIMEOUT_MS,
	);
	const outputDir = path.join(tmpdir(), "pi-eval", randomUUID());
	const outputFile = `${toSafePathSegment(evalCase.id, "case")}.json`;
	const outputPath = path.join(outputDir, outputFile);
	const rpcTraceDir = process.env.PI_EVAL_RPC_TRACE_DIR?.trim() || "";
	const rpcTracePath = rpcTraceDir.length > 0
		? path.join(path.resolve(rpcTraceDir), `${toSafePathSegment(evalCase.id, "case")}.jsonl`)
		: null;
	const rpcDiagnosticsPath = rpcTracePath
		? path.join(path.dirname(rpcTracePath), `${toSafePathSegment(evalCase.id, "case")}.diagnostics.json`)
		: null;
	const guestOutputPath = `${GUEST_OUTPUT_DIR}/${outputFile}`;
	const guestExtensionEntry = hostPathToGuest(extensionEntry, cwd, GUEST_WORKSPACE_DIR);
	const guestReadDenyPaths = mapReadDenyPathsToGuest({
		readDenyPaths,
		sandboxWorkspaceDir: cwd,
		sandboxHomeDir: homeDir,
	});
	const env = buildWorkerEnv(
		{
			outputPath: guestOutputPath,
			caseId: evalCase.id,
			dryRun,
			turnCount: prompts.length,
			agentDir: GUEST_WORKSPACE_DIR,
			allowedTools: tools,
			readDenyPaths: guestReadDenyPaths,
			bootstrapProfile,
			availableSkills,
			bootstrapManifestHash,
			homeDir: GUEST_HOME_DIR,
		},
		process.env,
	);
	await mkdir(outputDir, { recursive: true });
	if (rpcTracePath) await mkdir(path.dirname(rpcTracePath), { recursive: true });

	const engine = sandboxEngine ?? createMandatorySandboxEngine();
	const launch = await engine.launchWorker({
		command: "pi",
		args: buildWorkerArgs(model, thinkingLevel, tools, guestExtensionEntry),
		env,
		policy: {
			model,
			sandboxWorkspaceDir: cwd,
			workerOutputPath: outputPath,
			sandboxHomeDir: homeDir ?? null,
		},
	});
	const stderrChunks: string[] = [];
	launch.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

	const rpcState = createRpcState((line) => {
		if (!rpcTracePath) return;
		appendFile(rpcTracePath, `${line}\n`).catch(() => undefined);
	});
	const rl = createInterface({ input: launch.stdout });
	rl.on("line", rpcState.onLine);

	try {
		for (const prompt of prompts) {
			launch.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
			await withTimeout(rpcState.waitForAgentEnd(), caseTimeoutMs, `Case ${evalCase.id}`);
			if (rpcState.promptError) break;
		}
		launch.stdin.end();
		const closePromise = launch.waitForExit();

		const resultPromise = collectWorkerResult({
			outputPath,
			evalCase,
			dryRun,
			stderrChunks,
			promptError: rpcState.promptError,
		});
		const result = await resultPromise;
		const diagnostics = rpcState.diagnostics();
		attachRpcDiagnostics(result, diagnostics);
		await persistRpcDiagnostics(rpcDiagnosticsPath, diagnostics);
		try {
			await withTimeout(closePromise, shutdownTimeoutMs, `Case ${evalCase.id} shutdown`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push(`worker shutdown error: ${message}`);
			launch.kill();
			await closePromise.catch(() => undefined);
		}
		return result;
	} catch (error) {
		const diagnostics = rpcState.diagnostics();
		await persistRpcDiagnostics(rpcDiagnosticsPath, diagnostics);
		if (
			error instanceof Error &&
			error.message.includes(`Case ${evalCase.id}`) &&
			error.message.includes("timed out")
		) {
			throw new Error(`${error.message}${buildTimeoutDiagnosticsHint(diagnostics)}`, { cause: error });
		}
		throw error;
	} finally {
		rpcState.dispose();
		rl.close();
		await launch.cleanup();
		await rm(outputDir, { recursive: true, force: true });
	}
};
