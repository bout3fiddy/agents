/**
 * Worker result accumulator and builder.
 *
 * Tracks token usage, turn breakdown, output text, and read captures
 * across agent_end events, then assembles the final CaseRunResult.
 */
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import {
	isReferencePath,
	isSkillPath,
	serializeReadCapture,
	type ReadCapture,
} from "./capture.js";
import { modelSpecFromModel } from "./model-registry.js";
import type { CaseRunResult, ReadBreakdownEntry, TokenUsage, TurnTokenUsage, ToolUsageSummary } from "../data/types.js";
import type { PathDenyPolicy } from "./read-policy.js";
import { collectAssistantText, sumUsageFromMessages } from "./rpc-messages.js";
import {
	FORBIDDEN_WORKSPACE_VIOLATION,
	type SandboxBoundary,
} from "./sandbox-boundary.js";

// ── Types ───────────────────────────────────────────────────────────────

export type WorkerAccumulator = {
	outputChunks: string[];
	tokenTotals: TokenUsage;
	turnBreakdown: TurnTokenUsage[];
	completedTurns: number;
	finalized: boolean;
};

export type ToolUsageCapture = ToolUsageSummary;

// ── Factories ───────────────────────────────────────────────────────────

export const createAccumulator = (): WorkerAccumulator => ({
	outputChunks: [],
	tokenTotals: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	},
	turnBreakdown: [],
	completedTurns: 0,
	finalized: false,
});

export const createToolUsageCapture = (allowedTools: Set<string>): ToolUsageCapture => ({
	allowedTools: Array.from(allowedTools).sort(),
	writeCalls: 0,
	editCalls: 0,
	writeFailures: 0,
	editFailures: 0,
});

// ── Accumulation ────────────────────────────────────────────────────────

export const appendAgentEnd = (
	acc: WorkerAccumulator,
	messages: Array<AssistantMessage | ToolResultMessage>,
	countTurn = true,
): void => {
	const outputText = collectAssistantText(messages);
	if (outputText) acc.outputChunks.push(outputText);
	const usage = sumUsageFromMessages(messages);
	if (countTurn) {
		acc.turnBreakdown.push({
			turn: acc.completedTurns + 1,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
		});
	}
	acc.tokenTotals.input += usage.input;
	acc.tokenTotals.output += usage.output;
	acc.tokenTotals.cacheRead += usage.cacheRead;
	acc.tokenTotals.cacheWrite += usage.cacheWrite;
	acc.tokenTotals.totalTokens += usage.totalTokens;
	if (countTurn) acc.completedTurns += 1;
};

export const shouldFinalize = (acc: WorkerAccumulator, expectedTurns: number, force = false): boolean => {
	if (acc.finalized) return false;
	if (!force && acc.completedTurns < expectedTurns) return false;
	acc.finalized = true;
	return true;
};

// ── Read breakdown ──────────────────────────────────────────────────────

export const buildReadBreakdown = (readCapture: ReadCapture): ReadBreakdownEntry[] => {
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

// ── Result builder ──────────────────────────────────────────────────────

export const buildResult = (params: {
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
		turnBreakdown: acc.turnBreakdown,
	};
};
