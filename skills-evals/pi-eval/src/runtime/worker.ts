import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, realpath as fsRealpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	captureReadAttempt,
	captureReadInvocation,
	isSkillPath,
	serializeReadCapture,
	type ReadCapture,
} from "./capture.js";
import { modelSpecFromModel } from "./model-registry.js";
import type { CaseRunResult, TokenUsage } from "../data/types.js";
import { ensureDir, normalizePath } from "../data/utils.js";
import { parseWorkerRuntimeConfig } from "./worker-contract.js";

const DRY_RUN_SKILL_STUB = "Dry-run mode: file content unavailable.";
const FORBIDDEN_READ_ERROR = "ENOENT: no such file or directory";

type PathDenyPolicy = {
	logicalRoots: string[];
	canonicalRoots: string[];
	deniedReads: Set<string>;
	canonicalCache: Map<string, string | null>;
};

const hasPathPrefix = (candidate: string, root: string): boolean =>
	candidate === root ||
	candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

const resolveCanonical = async (
	absolutePath: string,
	cache: Map<string, string | null>,
): Promise<string | null> => {
	const cached = cache.get(absolutePath);
	if (cached !== undefined) return cached;
	try {
		const canonical = await fsRealpath(absolutePath);
		cache.set(absolutePath, canonical);
		return canonical;
	} catch {
		cache.set(absolutePath, null);
		return null;
	}
};

const createPathDenyPolicy = async (cwd: string, readDenyPaths: string[]): Promise<PathDenyPolicy> => {
	const logicalRoots = readDenyPaths.map((entry) => path.resolve(cwd, entry));
	const canonicalRoots: string[] = [];
	for (const root of logicalRoots) {
		const canonical = await fsRealpath(root).catch(() => null);
		if (canonical) canonicalRoots.push(canonical);
	}
	return {
		logicalRoots,
		canonicalRoots,
		deniedReads: new Set<string>(),
		canonicalCache: new Map<string, string | null>(),
	};
};

const assertReadablePath = async (absolutePath: string, policy: PathDenyPolicy): Promise<void> => {
	const logical = path.resolve(absolutePath);
	for (const root of policy.logicalRoots) {
		if (hasPathPrefix(logical, root)) {
			policy.deniedReads.add(normalizePath(logical));
			throw new Error(FORBIDDEN_READ_ERROR);
		}
	}
	const canonical = await resolveCanonical(logical, policy.canonicalCache);
	if (!canonical) return;
	for (const root of policy.canonicalRoots) {
		if (hasPathPrefix(canonical, root)) {
			policy.deniedReads.add(normalizePath(canonical));
			throw new Error(FORBIDDEN_READ_ERROR);
		}
	}
};

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

type ToolWithExecute = {
	execute: (toolCallId: string, args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
};

const adaptToolExecute = <T extends ToolWithExecute>(tool: T): T => ({
	...tool,
	execute: (toolCallId: string, args: Record<string, unknown>) =>
		tool.execute(toolCallId, args, undefined),
});

const createEvalReadTool = async (cwd: string, dryRunEnabled: boolean, readDenyPaths: string[]) => {
	const denyPolicy = await createPathDenyPolicy(cwd, readDenyPaths);
	const base = createReadTool(cwd, {
		operations: {
			access: async (absolutePath: string) => {
				await assertReadablePath(absolutePath, denyPolicy);
				if (dryRunEnabled && isSkillPath(absolutePath)) return;
				await fsAccess(absolutePath, constants.R_OK);
			},
			readFile: async (absolutePath: string) => {
				await assertReadablePath(absolutePath, denyPolicy);
				if (dryRunEnabled && isSkillPath(absolutePath)) return Buffer.from(DRY_RUN_SKILL_STUB);
				return fsReadFile(absolutePath);
			},
		},
	});

	return { denyPolicy, tool: adaptToolExecute(base) };
};

const createReadCapture = (): ReadCapture => ({
	skillAttempts: new Set<string>(),
	skillInvocations: new Set<string>(),
	refAttempts: new Set<string>(),
	refInvocations: new Set<string>(),
});

const registerReadCaptureHooks = (pi: ExtensionAPI, agentDir: string, readCapture: ReadCapture): void => {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		captureReadAttempt(path.resolve(ctx.cwd, rawPath), agentDir, readCapture);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		captureReadInvocation(path.resolve(ctx.cwd, rawPath), agentDir, readCapture);
		return undefined;
	});
};

type WorkerAccumulator = {
	outputChunks: string[];
	tokenTotals: TokenUsage;
	completedTurns: number;
	finalized: boolean;
};

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

const appendAgentEnd = (
	acc: WorkerAccumulator,
	messages: Array<AssistantMessage | ToolResultMessage>,
): void => {
	const outputText = collectAssistantText(messages);
	if (outputText) acc.outputChunks.push(outputText);
	const usage = sumUsage(messages);
	acc.tokenTotals.input += usage.input;
	acc.tokenTotals.output += usage.output;
	acc.tokenTotals.cacheRead += usage.cacheRead;
	acc.tokenTotals.cacheWrite += usage.cacheWrite;
	acc.tokenTotals.totalTokens += usage.totalTokens;
	acc.completedTurns += 1;
};

const shouldFinalize = (acc: WorkerAccumulator, expectedTurns: number): boolean => {
	if (acc.finalized) return false;
	if (acc.completedTurns < expectedTurns) return false;
	acc.finalized = true;
	return true;
};

const buildResult = (params: {
	caseId: string;
	dryRun: boolean;
	readCapture: ReadCapture;
	denyPolicy: PathDenyPolicy | null;
	acc: WorkerAccumulator;
	startedAt: number;
	model: any;
}): CaseRunResult => {
	const { caseId, dryRun, readCapture, denyPolicy, acc, startedAt, model } = params;
	const capturedReads = serializeReadCapture(readCapture);
	const deniedReadErrors = denyPolicy
		? Array.from(denyPolicy.deniedReads).sort().map((entry) => `forbidden read: ${entry}`)
		: [];

	return {
		caseId,
		dryRun,
		model: model ? modelSpecFromModel(model) : null,
		skillInvocations: capturedReads.skillInvocations,
		skillAttempts: capturedReads.skillAttempts,
		refInvocations: capturedReads.refInvocations,
		refAttempts: capturedReads.refAttempts,
		outputText: acc.outputChunks.join("\n").trim(),
		tokens: acc.tokenTotals,
		durationMs: Date.now() - startedAt,
		errors: deniedReadErrors,
	};
};

export const registerEvalWorker = async (pi: ExtensionAPI): Promise<boolean> => {
	const cwd = process.cwd();
	const config = parseWorkerRuntimeConfig(process.env, cwd);
	if (!config) return false;

	let denyPolicy: PathDenyPolicy | null = null;
	if (config.allowedTools.has("read")) {
		const readSetup = await createEvalReadTool(cwd, config.dryRun, config.readDenyPaths);
		denyPolicy = readSetup.denyPolicy;
		pi.registerTool(readSetup.tool);
	}
	if (config.allowedTools.has("edit")) pi.registerTool(adaptToolExecute(createEditTool(cwd)));
	if (config.allowedTools.has("write")) pi.registerTool(adaptToolExecute(createWriteTool(cwd)));

	const startedAt = Date.now();
	const readCapture = createReadCapture();
	const acc = createAccumulator();
	registerReadCaptureHooks(pi, config.agentDir, readCapture);

	pi.on("agent_end", async (event, ctx) => {
		appendAgentEnd(acc, event.messages as Array<AssistantMessage | ToolResultMessage>);
		if (!shouldFinalize(acc, config.expectedTurns)) return;

		const result = buildResult({
			caseId: config.caseId,
			dryRun: config.dryRun,
			readCapture,
			denyPolicy,
			acc,
			startedAt,
			model: ctx.model,
		});
		await ensureDir(path.dirname(config.outputPath));
		await writeFile(config.outputPath, JSON.stringify(result, null, 2));
		ctx.shutdown();
	});

	return true;
};
