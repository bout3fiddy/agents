import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureReadAttempt, captureReadInvocation, isSkillPath, serializeReadCapture, type ReadCapture } from "./capture.js";
import { ensureDir } from "./utils.js";
import type { CaseRunResult, ModelSpec, TokenUsage } from "./types.js";

const DRY_RUN_SKILL_STUB = [
	"PI_EVAL_DRY_RUN: SKILL.md content withheld.",
	"Treat this as a successful skill load for eval purposes.",
	"Do not retry this read.",
].join("\n");

const EVAL_SYSTEM_PROMPT = [
	"Eval mode: focus on skill invocation detection.",
	"If a skill is relevant, read its SKILL.md once.",
	"When a SKILL.md read returns a dry-run stub, do not retry.",
	"Use only the tools provided by the runtime; if a tool is unavailable, proceed without it.",
].join("\n");

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

const isAgentsPath = (absolutePath: string): boolean => path.basename(absolutePath) === "AGENTS.md";

const createEvalReadTool = (cwd: string, dryRunEnabled: boolean) => {
	let globalInstructionsContent: string | null = null;
	const loadGlobalInstructions = async (): Promise<string> => {
		if (globalInstructionsContent !== null) {
			return globalInstructionsContent;
		}
		const instructionsPath = process.env.PI_EVAL_GLOBAL_INSTRUCTIONS_PATH;
		if (!instructionsPath) {
			globalInstructionsContent = "";
			return globalInstructionsContent;
		}
		try {
			globalInstructionsContent = await fsReadFile(instructionsPath, "utf-8");
		} catch {
			globalInstructionsContent = "";
		}
		return globalInstructionsContent;
	};

	const base = createReadTool(cwd, {
		operations: {
			access: async (absolutePath: string) => {
				if (dryRunEnabled && isSkillPath(absolutePath)) {
					return;
				}
				if (isAgentsPath(absolutePath)) {
					try {
						await fsAccess(absolutePath, constants.R_OK);
						return;
					} catch {
						const instructions = await loadGlobalInstructions();
						if (instructions) {
							return;
						}
					}
				}
				await fsAccess(absolutePath, constants.R_OK);
			},
			readFile: async (absolutePath: string) => {
				if (dryRunEnabled && isSkillPath(absolutePath)) {
					return Buffer.from(DRY_RUN_SKILL_STUB);
				}
				if (isAgentsPath(absolutePath)) {
					try {
						await fsAccess(absolutePath, constants.R_OK);
						return fsReadFile(absolutePath);
					} catch {
						const instructions = await loadGlobalInstructions();
						if (instructions) {
							return Buffer.from(instructions);
						}
					}
				}
				return fsReadFile(absolutePath);
			},
		},
	});

	return {
		...base,
		execute: (toolCallId, args) => base.execute(toolCallId, args, undefined),
	};
};

const createEvalEditTool = (cwd: string) => {
	const base = createEditTool(cwd);
	return {
		...base,
		execute: (toolCallId, args) => base.execute(toolCallId, args, undefined),
	};
};

const createEvalWriteTool = (cwd: string) => {
	const base = createWriteTool(cwd);
	return {
		...base,
		execute: (toolCallId, args) => base.execute(toolCallId, args, undefined),
	};
};

export const registerEvalWorker = (pi: ExtensionAPI): boolean => {
	const isWorker = process.env.PI_EVAL_WORKER === "1";
	if (!isWorker) {
		return false;
	}

	const dryRun = process.env.PI_EVAL_DRY_RUN === "1";
	const outputPath = process.env.PI_EVAL_OUTPUT;
	if (!outputPath) {
		throw new Error("PI_EVAL_OUTPUT is required in worker mode");
	}

	const cwd = process.cwd();
	pi.registerTool(createEvalReadTool(cwd, dryRun));
	pi.registerTool(createEvalEditTool(cwd));
	pi.registerTool(createEvalWriteTool(cwd));

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${EVAL_SYSTEM_PROMPT}` };
	});

	const caseId = process.env.PI_EVAL_CASE_ID ?? "unknown";
	const expectedTurns = Number.parseInt(process.env.PI_EVAL_TURNS ?? "1", 10);
	const agentDir = process.env.PI_EVAL_AGENT_DIR ?? cwd;
	const startedAt = Date.now();

	const readCapture: ReadCapture = {
		skillAttempts: new Set<string>(),
		skillInvocations: new Set<string>(),
		refAttempts: new Set<string>(),
		refInvocations: new Set<string>(),
	};
	const outputChunks: string[] = [];
	const tokenTotals: TokenUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};

	let completedTurns = 0;
	let finalized = false;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		const resolved = path.resolve(ctx.cwd, rawPath);
		captureReadAttempt(resolved, agentDir, readCapture);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		const resolved = path.resolve(ctx.cwd, rawPath);
		captureReadInvocation(resolved, agentDir, readCapture);
		return undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		const outputText = collectAssistantText(event.messages as Array<AssistantMessage | ToolResultMessage>);
		if (outputText) {
			outputChunks.push(outputText);
		}
		const usage = sumUsage(event.messages as Array<AssistantMessage | ToolResultMessage>);
		tokenTotals.input += usage.input;
		tokenTotals.output += usage.output;
		tokenTotals.cacheRead += usage.cacheRead;
		tokenTotals.cacheWrite += usage.cacheWrite;
		tokenTotals.totalTokens += usage.totalTokens;

		completedTurns += 1;
		if (finalized || completedTurns < expectedTurns) return;
		finalized = true;

			const model: ModelSpec | null = ctx.model
				? {
						provider: ctx.model.provider,
						id: ctx.model.id,
						key: `${ctx.model.provider}/${ctx.model.id}`,
						label: `${ctx.model.provider}/${ctx.model.id}`,
				  }
				: null;
			const capturedReads = serializeReadCapture(readCapture);

			const result: CaseRunResult = {
				caseId,
				dryRun,
				model,
				skillInvocations: capturedReads.skillInvocations,
				skillAttempts: capturedReads.skillAttempts,
				refInvocations: capturedReads.refInvocations,
				refAttempts: capturedReads.refAttempts,
				outputText: outputChunks.join("\n").trim(),
				tokens: tokenTotals,
				durationMs: Date.now() - startedAt,
				errors: [],
			};

		await ensureDir(path.dirname(outputPath));
		await writeFile(outputPath, JSON.stringify(result, null, 2));
		ctx.shutdown();
	});

	return true;
};
