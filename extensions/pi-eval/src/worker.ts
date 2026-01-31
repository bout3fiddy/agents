import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir, normalizePath } from "./utils.js";
import type { CaseRunResult, ModelSpec, TokenUsage } from "./types.js";

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
			(message.usage?.input ?? 0) + (message.usage?.output ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0);
	}

	return { input, output, cacheRead, cacheWrite, totalTokens };
};

const toRelativePath = (filePath: string, baseDir: string): string => {
	const relative = path.relative(baseDir, filePath);
	return normalizePath(relative.startsWith("..") ? filePath : relative);
};

const isSkillPath = (filePath: string): boolean => normalizePath(filePath).endsWith("/SKILL.md");

const isReferencePath = (filePath: string): boolean => {
	const normalized = normalizePath(filePath);
	return normalized.includes("/references/") && normalized.endsWith(".md");
};

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

let evalModeRegistered = false;
let dryRunEnabled = false;
let globalInstructionsContent: string | null = null;

const setDryRunEnabled = (value: boolean) => {
	dryRunEnabled = value;
};

const parseDryRunValue = (input: string | undefined): boolean | null => {
	if (!input) return null;
	const normalized = input.trim().toLowerCase();
	if (["on", "true", "1", "yes"].includes(normalized)) return true;
	if (["off", "false", "0", "no"].includes(normalized)) return false;
	return null;
};

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

const isAgentsPath = (absolutePath: string): boolean =>
	path.basename(absolutePath) === "AGENTS.md";

const createEvalReadTool = (cwd: string) => {
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

const registerEvalMode = (pi: ExtensionAPI, initialDryRun: boolean) => {
	if (evalModeRegistered) return;
	evalModeRegistered = true;
	setDryRunEnabled(initialDryRun);
	const cwd = process.cwd();
	pi.registerTool(createEvalReadTool(cwd));
	pi.registerTool(createEvalEditTool(cwd));
	pi.registerTool(createEvalWriteTool(cwd));

	pi.registerCommand("eval-dry-run", {
		description: "Toggle eval dry-run stub for SKILL.md reads",
		handler: async (args, ctx) => {
			const parsed = parseDryRunValue(args);
			if (parsed === null) {
				const status = dryRunEnabled ? "on" : "off";
				if (ctx.hasUI) {
					ctx.ui.notify(`Eval dry-run is ${status}`, "info");
				}
				return;
			}
			setDryRunEnabled(parsed);
			if (ctx.hasUI) {
				ctx.ui.notify(`Eval dry-run ${parsed ? "enabled" : "disabled"}`, "info");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${EVAL_SYSTEM_PROMPT}` };
	});
};

export const registerEvalWorker = (pi: ExtensionAPI): boolean => {
	const isWorker = process.env.PI_EVAL_WORKER === "1";
	const isEvalMode = process.env.PI_EVAL_MODE === "1";

	if (!isWorker && !isEvalMode) {
		return false;
	}

	const dryRun = process.env.PI_EVAL_DRY_RUN === "1";
	registerEvalMode(pi, dryRun);

	if (!isWorker) {
		return true;
	}

	const outputPath = process.env.PI_EVAL_OUTPUT;
	if (!outputPath) {
		throw new Error("PI_EVAL_OUTPUT is required in worker mode");
	}

	const caseId = process.env.PI_EVAL_CASE_ID ?? "unknown";
	const expectedTurns = Number.parseInt(process.env.PI_EVAL_TURNS ?? "1", 10);
	const agentDir = process.env.PI_EVAL_AGENT_DIR ?? process.cwd();
	const startedAt = Date.now();

	const skillAttempts = new Set<string>();
	const skillInvocations = new Set<string>();
	const refAttempts = new Set<string>();
	const refInvocations = new Set<string>();
	const errors: string[] = [];
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
		const relPath = toRelativePath(resolved, agentDir);

		if (isSkillPath(resolved)) {
			const skillName = path.basename(path.dirname(resolved));
			skillAttempts.add(skillName);
		}

		if (isReferencePath(resolved)) {
			refAttempts.add(relPath);
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		const resolved = path.resolve(ctx.cwd, rawPath);
		const relPath = toRelativePath(resolved, agentDir);

		if (isSkillPath(resolved)) {
			const skillName = path.basename(path.dirname(resolved));
			skillInvocations.add(skillName);
		}

		if (isReferencePath(resolved)) {
			refInvocations.add(relPath);
		}

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

		const result: CaseRunResult = {
			caseId,
			dryRun,
			model,
			skillInvocations: Array.from(skillInvocations).sort(),
			skillAttempts: Array.from(skillAttempts).sort(),
			refInvocations: Array.from(refInvocations).sort(),
			refAttempts: Array.from(refAttempts).sort(),
			outputText: outputChunks.join("\n").trim(),
			tokens: tokenTotals,
			durationMs: Date.now() - startedAt,
			errors,
		};

		await ensureDir(path.dirname(outputPath));
		await writeFile(outputPath, JSON.stringify(result, null, 2));
		ctx.shutdown();
	});

	return true;
};
