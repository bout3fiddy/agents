import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { tokenizeArgs, parseFlags } from "./args.js";
import { parseLimitFlag, parseStringFlag, resolveCasesPath } from "./validation.js";
import { runAudit } from "./audit.js";
import { loadCases, filterCases } from "./cases.js";
import { loadEvalConfig } from "./config.js";
import { color, logLines, logPanelWithTimestamp, logWithTimestamp, renderPanel, renderTable, symbols } from "./logger.js";
import { buildReport, renderReportNotice, updateIndex, writeReport } from "./report.js";
import { discoverSkills } from "./skills.js";
import type {
	CaseEvaluation,
	CaseRunResult,
	EvalCase,
	EvalConfig,
	MatrixEvaluation,
	ModelSpec,
	SkillInfo,
} from "./types.js";
import { fileExists, formatDuration, normalizePath, resolvePath } from "./utils.js";

const DEFAULT_CASES_PATH = "skills-evals/specs/pi-eval/evals.md";
const DEFAULT_SMOKE_LIMIT = 5;
const CASE_TIMEOUT_MS = 180_000;

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionEntry = path.join(extensionRoot, "index.ts");

const resolveSkillsPaths = (config: EvalConfig, agentDir: string): string[] => {
	const defaults = config.defaults?.skillsPaths ?? ["skills"];
	return defaults.map((item) => resolvePath(item, agentDir));
};

const modelSpecFromModel = (model: Model<any>): ModelSpec => ({
	provider: model.provider,
	id: model.id,
	key: `${model.provider}/${model.id}`,
	label: `${model.provider}/${model.id}`,
});

const resolveModelSpec = async (
	modelArg: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<ModelSpec> => {
	if (modelArg) {
		if (modelArg.includes("/")) {
			const [provider, id] = modelArg.split("/");
			return {
				provider,
				id,
				key: `${provider}/${id}`,
				label: `${provider}/${id}`,
			};
		}
		const available = await ctx.modelRegistry.getAvailable();
		const match = available.find((item) => item.id === modelArg);
		if (match) return modelSpecFromModel(match);
		throw new Error(`Model not found: ${modelArg}`);
	}

	if (ctx.model) {
		return modelSpecFromModel(ctx.model);
	}

	const available = await ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		throw new Error("No models available. Configure a provider or login.");
	}
	return modelSpecFromModel(available[0]);
};

const ensureModelAuth = async (model: ModelSpec, ctx: ExtensionCommandContext): Promise<void> => {
	const resolved = ctx.modelRegistry.find(model.provider, model.id);
	if (!resolved) {
		throw new Error(`Model not registered: ${model.provider}/${model.id}`);
	}
	const apiKey = await ctx.modelRegistry.getApiKey(resolved);
	if (!apiKey) {
		throw new Error(
			`Missing credentials for ${model.provider}/${model.id}. Authenticate before running evals.`,
		);
	}
};

const resolveSkillMap = (skills: SkillInfo[]): Map<string, SkillInfo> => {
	const map = new Map<string, SkillInfo>();
	for (const skill of skills) {
		if (!map.has(skill.name)) {
			map.set(skill.name, skill);
		}
	}
	return map;
};

const buildCaseResult = (
	caseId: string,
	mode: "single" | "baseline" | "interference",
	result: CaseRunResult,
	evalCase: EvalCase,
	reasons: string[],
): CaseEvaluation => ({
	caseId,
	suite: evalCase.suite,
	mode,
	status: reasons.length === 0 ? "pass" : "fail",
	reasons,
	result,
	expectedSkills: evalCase.expectedSkills,
	disallowedSkills: evalCase.disallowedSkills,
	expectedRefs: evalCase.expectedRefs,
	assertions: evalCase.assertions ?? [],
	tokenBudget: evalCase.tokenBudget ?? null,
});

const evaluateCase = async (
	evalCase: EvalCase,
	result: CaseRunResult,
	mode: "single" | "baseline" | "interference",
): Promise<CaseEvaluation> => {
	const reasons: string[] = [];
	const useAttempts = result.dryRun;
	const invokedSkills = useAttempts ? result.skillAttempts : result.skillInvocations;
	const invokedRefs = useAttempts ? result.refAttempts : result.refInvocations;

	for (const skill of evalCase.expectedSkills ?? []) {
		if (!invokedSkills.includes(skill)) {
			reasons.push(`missing skill: ${skill}`);
		}
	}
	for (const skill of evalCase.disallowedSkills ?? []) {
		if (invokedSkills.includes(skill)) {
			reasons.push(`unexpected skill: ${skill}`);
		}
	}
	for (const ref of evalCase.expectedRefs ?? []) {
		if (!invokedRefs.includes(ref)) {
			reasons.push(`missing reference: ${ref}`);
		}
	}

	const fileAssertions = evalCase.fileAssertions ?? [];
	if (fileAssertions.length > 0) {
		const workspaceDir = result.workspaceDir;
		if (!workspaceDir) {
			reasons.push("missing workspace for file assertions");
		} else {
			for (const assertion of fileAssertions) {
				const targetPath = path.join(workspaceDir, assertion.path);
				let content = "";
				try {
					content = await readFile(targetPath, "utf-8");
				} catch {
					reasons.push(`missing file: ${assertion.path}`);
					continue;
				}
				for (const needle of assertion.mustContain ?? []) {
					if (!content.includes(needle)) {
						reasons.push(`file assertion failed: ${assertion.path} missing ${needle}`);
					}
				}
				for (const needle of assertion.mustNotContain ?? []) {
					if (content.includes(needle)) {
						reasons.push(`file assertion failed: ${assertion.path} contains ${needle}`);
					}
				}
			}
		}
	}

	const outputText = result.outputText ?? "";
	for (const assertion of evalCase.assertions ?? []) {
		if (assertion.startsWith("must_contain:")) {
			const needle = assertion.slice("must_contain:".length);
			if (!outputText.includes(needle)) {
				reasons.push(`assertion failed: ${assertion}`);
			}
			continue;
		}
		if (assertion.startsWith("must_not_contain:")) {
			const needle = assertion.slice("must_not_contain:".length);
			if (outputText.includes(needle)) {
				reasons.push(`assertion failed: ${assertion}`);
			}
			continue;
		}
		reasons.push(`unknown assertion: ${assertion}`);
	}

	const budget = evalCase.tokenBudget ?? null;
	if (budget !== null && result.tokens.totalTokens > budget) {
		reasons.push(`token budget exceeded (${result.tokens.totalTokens} > ${budget})`);
	}

	if (result.errors.length > 0) {
		reasons.push(...result.errors.map((err) => `run error: ${err}`));
	}

	return buildCaseResult(evalCase.id, mode, result, evalCase, reasons);
};

const renderRunSummary = (evaluations: CaseEvaluation[], durationMs: number) => {
	const passed = evaluations.filter((item) => item.status === "pass").length;
	const failed = evaluations.length - passed;
	const summary = renderPanel(
		"Pi Eval Summary",
		[
			`${color.accent("Cases")}: ${evaluations.length}`,
			`${color.accent("Pass")}: ${passed}`,
			`${color.accent("Fail")}: ${failed}`,
			`${color.accent("Duration")}: ${formatDuration(durationMs)}`,
		].join("\n"),
	);
	console.log(summary);
	console.log("");
};

const buildCaseTable = (evaluations: CaseEvaluation[]): string => {
	const rows = evaluations.map((item) => {
		const status = item.status === "pass" ? symbols.ok : symbols.fail;
		const tokenCount = item.result.tokens.totalTokens || 0;
		const reason = item.reasons[0] ?? "";
		return [status, item.caseId, item.mode, tokenCount, reason];
	});
	return renderTable(["Status", "Case", "Mode", "Tokens", "Notes"], rows);
};

const formatTimingValue = (value?: number | null): string =>
	value === null || value === undefined ? "-" : formatDuration(value);

const logCaseProfile = (caseId: string, timings?: CaseRunResult["timings"]) => {
	if (!timings) return;
	const promptTotal = (timings.promptToAgentEndMs ?? []).reduce((sum, value) => sum + value, 0);
	const line = [
		`total ${formatTimingValue(timings.totalMs)}`,
		`prompt ${formatTimingValue(promptTotal)}`,
		`spawn ${formatTimingValue(timings.spawnToFirstEventMs ?? null)}`,
		`output ${formatTimingValue(timings.agentEndToOutputMs ?? null)}`,
		`shutdown ${formatTimingValue(timings.shutdownMs ?? null)}`,
	].join(" · ");
	console.log(color.muted(`[profile] ${caseId}: ${line}`));
};

const resolveSkillPaths = (names: string[], skillMap: Map<string, SkillInfo>) => {
	const missing: string[] = [];
	const paths: string[] = [];
	for (const name of names) {
		const skill = skillMap.get(name);
		if (!skill) {
			missing.push(name);
			continue;
		}
		paths.push(skill.skillFile);
	}
	return { paths, missing };
};

const DEFAULT_TOOLS = ["read"];

const resolveTools = (evalCase: EvalCase): string[] => {
	const tools = evalCase.tools && evalCase.tools.length > 0 ? [...evalCase.tools] : [...DEFAULT_TOOLS];
	if (!tools.includes("read")) {
		tools.unshift("read");
	}
	return tools;
};

const isReadOnlyTools = (tools: string[]): boolean =>
	tools.length === 1 && tools[0] === "read";

const resolveSandbox = (evalCase: EvalCase, dryRun: boolean): boolean =>
	evalCase.sandbox ?? (!dryRun || Boolean(evalCase.fileAssertions?.length));

const SANDBOX_EXCLUDES = [
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
	"coverage",
	".cache",
	"docs/specs/pi-eval/reports",
	"docs/specs/pi-eval/logs",
];

const shouldCopyToSandbox = (sourcePath: string, baseDir: string): boolean => {
	const relative = normalizePath(path.relative(baseDir, sourcePath));
	if (!relative || relative === ".") return true;
	return !SANDBOX_EXCLUDES.some(
		(entry) => relative === entry || relative.startsWith(`${entry}/`),
	);
};

const createSandbox = async (agentDir: string, caseId: string): Promise<string> => {
	const sandboxDir = path.join(tmpdir(), "pi-eval-sandbox", caseId, randomUUID());
	await mkdir(sandboxDir, { recursive: true });
	await cp(agentDir, sandboxDir, {
		recursive: true,
		force: true,
		filter: (source) => shouldCopyToSandbox(source, agentDir),
	});
	return sandboxDir;
};

const cleanupSandbox = async (sandboxDir: string | null): Promise<void> => {
	if (!sandboxDir) return;
	await rm(sandboxDir, { recursive: true, force: true });
};

const mapSkillPathsToSandbox = (paths: string[], agentDir: string, sandboxDir: string): string[] =>
	paths.map((skillPath) => path.join(sandboxDir, path.relative(agentDir, skillPath)));

const requiresIsolatedRun = (evalCase: EvalCase, dryRun: boolean): boolean => {
	const tools = resolveTools(evalCase);
	const sandbox = resolveSandbox(evalCase, dryRun);
	return sandbox || !isReadOnlyTools(tools);
};

const buildStubResult = (
	caseId: string,
	dryRun: boolean,
	errors: string[],
	timings?: CaseRunResult["timings"],
): CaseRunResult => ({
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
	timings,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
	let timeoutId: NodeJS.Timeout;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	const result = await Promise.race([promise, timeoutPromise]);
	clearTimeout(timeoutId!);
	return result;
};

const waitForFile = async (filePath: string, timeoutMs = 10_000, intervalMs = 250): Promise<boolean> => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fileExists(filePath)) {
			return true;
		}
		await sleep(intervalMs);
	}
	return false;
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

const extractAssistantText = (message: any): string => {
	if (!message || message.role !== "assistant") return "";
	if (!Array.isArray(message.content)) return "";
	const chunks: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			chunks.push(block.text);
		}
	}
	return chunks.join("\n");
};

const addUsage = (message: any, totals: CaseRunResult["tokens"]) => {
	if (!message || message.role !== "assistant") return;
	const usage = message.usage ?? {};
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	totals.input += input;
	totals.output += output;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.totalTokens += totalTokens;
};

type CaseLogger = {
	log: (message: string) => void;
	logBlock: (label: string, content: string) => void;
	trace: (message: string) => void;
	traceBlock: (label: string, content: string) => void;
	enabled: boolean;
	traceEnabled: boolean;
};

const logVerbose = (enabled: boolean, message: string) => {
	if (!enabled) return;
	logWithTimestamp(message);
};

const logVerboseBlock = (enabled: boolean, label: string, content: string) => {
	if (!enabled) return;
	logWithTimestamp(label);
	logLines(content, { prefix: "  " });
};

const createCaseLogger = (label: string, verbose: boolean, trace: boolean): CaseLogger | null => {
	const enabled = verbose || trace;
	if (!enabled) return null;
	const prefix = color.accent(`[${label}]`);
	const logLine = (message: string) => {
		if (!verbose) return;
		logWithTimestamp(`${prefix} ${message}`);
	};
	const logBlock = (title: string, content: string) => {
		if (!verbose) return;
		logWithTimestamp(`${prefix} ${title}:`);
		logLines(content, { prefix: `${prefix}   ` });
	};
	const traceLine = (message: string) => {
		if (!trace) return;
		logWithTimestamp(`${prefix} ${color.muted(message)}`);
	};
	const traceBlock = (title: string, content: string) => {
		if (!trace) return;
		logWithTimestamp(`${prefix} ${color.muted(title)}:`);
		logLines(content, { prefix: `${prefix}   ` });
	};
	return {
		log: logLine,
		logBlock,
		trace: traceLine,
		traceBlock,
		enabled,
		traceEnabled: trace,
	};
};

const logCaseMetadata = (
	logger: CaseLogger | null,
	params: {
		evalCase: EvalCase;
		mode: "single" | "baseline" | "interference";
		dryRun: boolean;
		thinkingLevel: string;
		skillSet: string[];
		reuse: boolean;
		tools?: string[];
		sandbox?: boolean;
	},
) => {
	if (!logger) return;
	const { evalCase, mode, dryRun, thinkingLevel, skillSet, reuse } = params;
	const details: string[] = [];
	details.push(`${color.accent("Suite")}: ${evalCase.suite}`);
	details.push(
		`${color.accent("Mode")}: ${mode}${reuse ? " (reuse)" : ""} · ` +
			`${color.accent("Dry-run")}: ${dryRun ? "on" : "off"} · ` +
			`${color.accent("Thinking")}: ${thinkingLevel}`,
	);
	details.push(`${color.accent("Turns")}: ${1 + (evalCase.turns?.length ?? 0)}`);
	if (skillSet.length > 0) {
		details.push(`${color.accent("Skills")}: ${skillSet.length}`);
		details.push(color.muted(skillSet.join("\n")));
	}
	const tools = params.tools ?? [];
	if (tools.length > 0) {
		details.push(`${color.accent("Tools")}: ${tools.join(", ")}`);
	}
	if (params.sandbox !== undefined) {
		details.push(`${color.accent("Sandbox")}: ${params.sandbox ? "on" : "off"}`);
	}
	if (evalCase.expectedSkills?.length) {
		details.push(`${color.accent("Expected skills")}: ${evalCase.expectedSkills.join(", ")}`);
	}
	if (evalCase.disallowedSkills?.length) {
		details.push(`${color.accent("Disallowed skills")}: ${evalCase.disallowedSkills.join(", ")}`);
	}
	if (evalCase.expectedRefs?.length) {
		details.push(`${color.accent("Expected refs")}: ${evalCase.expectedRefs.length}`);
		details.push(color.muted(evalCase.expectedRefs.join("\n")));
	}
	if (evalCase.fileAssertions?.length) {
		details.push(`${color.accent("File assertions")}: ${evalCase.fileAssertions.length}`);
		details.push(color.muted(evalCase.fileAssertions.map((item) => item.path).join("\n")));
	}
	if (evalCase.assertions?.length) {
		details.push(`${color.accent("Assertions")}: ${evalCase.assertions.length}`);
		details.push(color.muted(evalCase.assertions.join("\n")));
	}
	if (evalCase.tokenBudget !== null && evalCase.tokenBudget !== undefined) {
		details.push(`${color.accent("Token budget")}: ${evalCase.tokenBudget}`);
	}
	logPanelWithTimestamp(`${evalCase.id}${mode === "single" ? "" : ` ${mode}`}`, details.join("\n"));
};

const formatToolArgs = (toolName: string, args: any): string => {
	if (!args || typeof args !== "object") return "";
	if (toolName === "read") {
		const pathValue = typeof args.path === "string" ? args.path : "";
		return pathValue ? `path=${pathValue}` : "";
	}
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
};

const runCaseProcess = async (params: {
	evalCase: EvalCase;
	skillPaths: string[];
	model: ModelSpec;
	agentDir: string;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	logger?: CaseLogger | null;
}): Promise<CaseRunResult> => {
	const { evalCase, skillPaths, model, agentDir, cwd, dryRun, thinkingLevel, tools, logger } = params;
	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const caseStart = Date.now();
	const promptTimings: number[] = [];
	let promptStartAt: number | null = null;
	let lastAgentEndAt: number | null = null;
	let firstEventAt: number | null = null;
	let outputIndex = 0;

	const outputDir = path.join(tmpdir(), "pi-eval", randomUUID());
	const outputPath = path.join(outputDir, `${evalCase.id}.json`);

	const env = {
		...process.env,
		PI_EVAL_MODE: "1",
		PI_EVAL_WORKER: "1",
		PI_EVAL_OUTPUT: outputPath,
		PI_EVAL_CASE_ID: evalCase.id,
		PI_EVAL_DRY_RUN: dryRun ? "1" : "0",
		PI_EVAL_TURNS: String(prompts.length),
		PI_EVAL_AGENT_DIR: agentDir,
	};

	const toolArg = tools.length > 0 ? tools.join(",") : "read";

	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionEntry,
		"--no-skills",
		"--tools",
		toolArg,
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--thinking",
		thinkingLevel,
	];

	for (const skillPath of skillPaths) {
		args.push("--skill", skillPath);
	}

	const proc = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const stderrChunks: string[] = [];
	proc.stderr?.on("data", (chunk) => {
		const text = String(chunk);
		stderrChunks.push(text);
		if (logger?.traceEnabled) {
			const trimmed = text.trimEnd();
			if (trimmed) {
				logger.traceBlock("worker stderr", trimmed);
			}
		}
	});

	const rl = createInterface({ input: proc.stdout });
	const pendingResolvers: Array<() => void> = [];
	let pendingAgentEnds = 0;
	let promptError: string | null = null;

	rl.on("line", (line) => {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (firstEventAt === null) {
			firstEventAt = Date.now();
		}

		if (event.type === "response" && event.command === "prompt" && event.success === false) {
			promptError = event.error ?? "prompt rejected";
			if (promptError && logger) {
				logger.log(`${color.error("prompt error")}: ${promptError}`);
			}
		}

		if (event.type === "agent_start") {
			logger?.log(color.accent("agent start"));
		}

		if (event.type === "message_end") {
			const text = extractAssistantText(event.message);
			if (text) {
				outputIndex += 1;
				logger?.logBlock(color.success(`output ${outputIndex}`), text);
			}
		}

		if (event.type === "message_update" && logger?.traceEnabled) {
			const delta = event.assistantMessageEvent?.delta;
			const deltaType = event.assistantMessageEvent?.type;
			if (typeof delta === "string" && delta.length > 0) {
				logger.trace(`${deltaType ?? "delta"}: ${delta}`);
			} else if (deltaType && deltaType !== "done") {
				logger.trace(`message_update: ${deltaType}`);
			}
		}

		if (event.type === "tool_execution_start") {
			const argsSummary = formatToolArgs(event.toolName, event.args);
			logger?.log(
				`${color.warning("tool")} ${event.toolName} start${argsSummary ? ` (${argsSummary})` : ""}`,
			);
		}

		if (event.type === "tool_execution_end") {
			const errorSuffix = event.isError ? " (error)" : "";
			logger?.log(`${color.warning("tool")} ${event.toolName} end${errorSuffix}`);
		}

		if (event.type === "agent_end") {
			if (promptStartAt !== null) {
				promptTimings.push(Date.now() - promptStartAt);
				promptStartAt = null;
			}
			lastAgentEndAt = Date.now();
			if (pendingResolvers.length > 0) {
				const resolve = pendingResolvers.shift();
				resolve?.();
			} else {
				pendingAgentEnds += 1;
			}
		}
	});

	const waitForAgentEnd = () =>
		new Promise<void>((resolve) => {
			if (pendingAgentEnds > 0) {
				pendingAgentEnds -= 1;
				resolve();
				return;
			}
			pendingResolvers.push(resolve);
		});

	const sendPrompt = (message: string) => {
		promptStartAt = Date.now();
		const payload = JSON.stringify({ type: "prompt", message });
		proc.stdin?.write(`${payload}\n`);
	};

	for (const [index, prompt] of prompts.entries()) {
		logger?.logBlock(color.accent(`prompt ${index + 1}/${prompts.length}`), prompt);
		sendPrompt(prompt);
		await withTimeout(waitForAgentEnd(), CASE_TIMEOUT_MS, `Case ${evalCase.id}`);
		if (promptError) break;
	}

	const closePromise = new Promise<void>((resolve, reject) => {
		proc.on("close", () => resolve());
		proc.on("error", (error) => reject(error));
	});

	const outputReady = await waitForFile(outputPath, 15_000);
	const outputReadyAt = outputReady ? Date.now() : null;
	const shutdownStart = Date.now();
	if (!proc.killed) {
		proc.kill();
	}

	let shutdownMs: number | null = null;
	try {
		await withTimeout(closePromise, 10_000, `Case ${evalCase.id} shutdown`);
		shutdownMs = Date.now() - shutdownStart;
	} catch (error) {
		if (!proc.killed) {
			proc.kill("SIGKILL");
		}
		throw error;
	}

	const timings = {
		spawnToFirstEventMs: firstEventAt ? firstEventAt - caseStart : null,
		promptToAgentEndMs: promptTimings,
		agentEndToOutputMs:
			outputReadyAt && lastAgentEndAt ? outputReadyAt - lastAgentEndAt : null,
		shutdownMs,
		totalMs: Date.now() - caseStart,
	};

	try {
		if (!outputReady) {
			return buildStubResult(
				evalCase.id,
				dryRun,
				[promptError ?? "no output from worker", ...stderrChunks],
				timings,
			);
		}

		const raw = await readFile(outputPath, "utf-8");
		const result = JSON.parse(raw) as CaseRunResult;
		result.timings = timings;
		if (promptError) {
			result.errors.push(promptError);
		}
		if (stderrChunks.length > 0) {
			result.errors.push(...stderrChunks.map((line) => line.trim()).filter(Boolean));
		}
		return result;
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
};

type RpcClient = {
	startedAt: number;
	readonly firstEventAt: number | null;
	stderrChunks: string[];
	sendCommand: (command: Record<string, unknown>) => Promise<any>;
	onEvent: (handler: (event: any) => void) => () => void;
	close: () => Promise<void>;
};

const createRpcClient = (params: {
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}): RpcClient => {
	const { args, env, cwd } = params;
	const startedAt = Date.now();
	const proc = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const stderrChunks: string[] = [];
	const responseWaiters = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>();
	const eventListeners = new Set<(event: any) => void>();
	let firstEventAt: number | null = null;

	proc.stderr?.on("data", (chunk) => {
		stderrChunks.push(String(chunk));
	});

	proc.on("close", () => {
		for (const waiter of responseWaiters.values()) {
			waiter.reject(new Error("RPC process closed"));
		}
		responseWaiters.clear();
	});

	const rl = createInterface({ input: proc.stdout });
	rl.on("line", (line) => {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (firstEventAt === null) {
			firstEventAt = Date.now();
		}

		if (event.type === "response" && typeof event.id === "string") {
			const waiter = responseWaiters.get(event.id);
			if (waiter) {
				responseWaiters.delete(event.id);
				waiter.resolve(event);
			}
			return;
		}

		for (const listener of eventListeners) {
			listener(event);
		}
	});

	const sendCommand = async (command: Record<string, unknown>) => {
		const id = (command.id as string | undefined) ?? randomUUID();
		const payload = { ...command, id };
		return new Promise((resolve, reject) => {
			responseWaiters.set(id, { resolve, reject });
			proc.stdin?.write(`${JSON.stringify(payload)}\n`);
		});
	};

	const onEvent = (handler: (event: any) => void) => {
		eventListeners.add(handler);
		return () => eventListeners.delete(handler);
	};

	const close = async () => {
		if (!proc.killed) {
			proc.kill();
		}
		await new Promise<void>((resolve) => {
			proc.on("close", () => resolve());
		});
	};

	const client: RpcClient = {
		startedAt,
		get firstEventAt() {
			return firstEventAt;
		},
		stderrChunks,
		sendCommand,
		onEvent,
		close,
	};

	return client;
};

class ReusePool {
	private clients = new Map<string, RpcClient>();

	constructor(
		private agentDir: string,
		private model: ModelSpec,
		private thinkingLevel: string,
	) {}

	async getClient(skillNames: string[], skillPaths: string[]): Promise<RpcClient> {
		const key = [...skillNames].sort().join(",");
		const existing = this.clients.get(key);
		if (existing) return existing;

		const env = {
			...process.env,
			PI_EVAL_MODE: "1",
			PI_EVAL_DRY_RUN: "0",
			PI_EVAL_AGENT_DIR: this.agentDir,
		};

		const args = [
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			extensionEntry,
			"--no-skills",
			"--tools",
			"read",
			"--provider",
			this.model.provider,
			"--model",
			this.model.id,
			"--thinking",
			this.thinkingLevel,
		];

		for (const skillPath of skillPaths) {
			args.push("--skill", skillPath);
		}

		const client = createRpcClient({ args, env, cwd: this.agentDir });
		this.clients.set(key, client);
		return client;
	}

	async closeAll(): Promise<void> {
		for (const client of this.clients.values()) {
			await client.close();
		}
		this.clients.clear();
	}
}

const runCaseWithClient = async (params: {
	client: RpcClient;
	evalCase: EvalCase;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	logger?: CaseLogger | null;
}): Promise<CaseRunResult> => {
	const { client, evalCase, model, agentDir, dryRun, logger } = params;
	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const caseStart = Date.now();
	const promptTimings: number[] = [];
	let promptStartAt: number | null = null;
	let lastAgentEndAt: number | null = null;
	let outputIndex = 0;

	const skillAttempts = new Set<string>();
	const skillInvocations = new Set<string>();
	const refAttempts = new Set<string>();
	const refInvocations = new Set<string>();
	const errors: string[] = [];
	const outputChunks: string[] = [];
	const tokenTotals: CaseRunResult["tokens"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};

	const stderrStart = client.stderrChunks.length;
	let pendingAgentEnds = 0;
	const pendingResolvers: Array<() => void> = [];
	let caseActive = false;

	const waitForAgentEnd = () =>
		new Promise<void>((resolve) => {
			if (pendingAgentEnds > 0) {
				pendingAgentEnds -= 1;
				resolve();
				return;
			}
			pendingResolvers.push(resolve);
		});

	const removeListener = client.onEvent((event) => {
		if (!caseActive) {
			return;
		}

		if (event.type === "agent_start") {
			logger?.log(color.accent("agent start"));
		}

		if (event.type === "message_update" && logger?.traceEnabled) {
			const delta = event.assistantMessageEvent?.delta;
			const deltaType = event.assistantMessageEvent?.type;
			if (typeof delta === "string" && delta.length > 0) {
				logger.trace(`${deltaType ?? "delta"}: ${delta}`);
			} else if (deltaType && deltaType !== "done") {
				logger.trace(`message_update: ${deltaType}`);
			}
		}

		if (event.type === "tool_execution_start") {
			const argsSummary = formatToolArgs(event.toolName, event.args);
			logger?.log(
				`${color.warning("tool")} ${event.toolName} start${argsSummary ? ` (${argsSummary})` : ""}`,
			);
		}

		if (event.type === "tool_execution_start" && event.toolName === "read") {
			const rawPath = event.args?.path;
			if (typeof rawPath === "string") {
				const resolved = path.resolve(agentDir, rawPath);
				const relPath = toRelativePath(resolved, agentDir);
				if (isSkillPath(resolved)) {
					const skillName = path.basename(path.dirname(resolved));
					skillAttempts.add(skillName);
				}
				if (isReferencePath(resolved)) {
					refAttempts.add(relPath);
				}
			}
		}

		if (event.type === "tool_execution_end") {
			const errorSuffix = event.isError ? " (error)" : "";
			logger?.log(`${color.warning("tool")} ${event.toolName} end${errorSuffix}`);
		}

		if (event.type === "tool_execution_end" && event.toolName === "read") {
			const rawPath = event.args?.path;
			if (typeof rawPath === "string") {
				const resolved = path.resolve(agentDir, rawPath);
				const relPath = toRelativePath(resolved, agentDir);
				if (isSkillPath(resolved)) {
					const skillName = path.basename(path.dirname(resolved));
					skillInvocations.add(skillName);
				}
				if (isReferencePath(resolved)) {
					refInvocations.add(relPath);
				}
			}
		}

		if (event.type === "message_end") {
			const text = extractAssistantText(event.message);
			if (text) {
				outputChunks.push(text);
				outputIndex += 1;
				logger?.logBlock(color.success(`output ${outputIndex}`), text);
			}
			addUsage(event.message, tokenTotals);
		}

		if (event.type === "agent_end") {
			if (promptStartAt !== null) {
				promptTimings.push(Date.now() - promptStartAt);
				promptStartAt = null;
			}
			lastAgentEndAt = Date.now();
			if (pendingResolvers.length > 0) {
				const resolve = pendingResolvers.shift();
				resolve?.();
			} else {
				pendingAgentEnds += 1;
			}
		}
	});

	const sessionResponse = await client.sendCommand({ type: "new_session" });
	if (sessionResponse?.success === false) {
		const errorMessage = sessionResponse.error ?? "new_session failed";
		errors.push(errorMessage);
		logger?.log(`${color.error("new_session error")}: ${errorMessage}`);
	}
	const dryRunResponse = await client.sendCommand({
		type: "prompt",
		message: `/eval-dry-run ${dryRun ? "on" : "off"}`,
	});
	if (dryRunResponse?.success === false) {
		const errorMessage = dryRunResponse.error ?? "eval-dry-run failed";
		errors.push(errorMessage);
		logger?.log(`${color.error("eval-dry-run error")}: ${errorMessage}`);
	}
	caseActive = true;

	for (const [index, prompt] of prompts.entries()) {
		logger?.logBlock(color.accent(`prompt ${index + 1}/${prompts.length}`), prompt);
		promptStartAt = Date.now();
		const response = await client.sendCommand({ type: "prompt", message: prompt });
		if (response.success === false) {
			const errorMessage = response.error ?? "prompt rejected";
			errors.push(errorMessage);
			logger?.log(`${color.error("prompt error")}: ${errorMessage}`);
			break;
		}
		await withTimeout(waitForAgentEnd(), CASE_TIMEOUT_MS, `Case ${evalCase.id}`);
	}

	removeListener();

	const stderrNew = client.stderrChunks.slice(stderrStart).map((line) => line.trim()).filter(Boolean);
	if (stderrNew.length > 0) {
		errors.push(...stderrNew);
		if (logger?.traceEnabled) {
			logger.traceBlock("worker stderr", stderrNew.join("\n"));
		}
	}

	const timings = {
		spawnToFirstEventMs: client.firstEventAt ? client.firstEventAt - client.startedAt : null,
		promptToAgentEndMs: promptTimings,
		agentEndToOutputMs: null,
		shutdownMs: null,
		totalMs: Date.now() - caseStart,
	};

	const durationMs = promptTimings.reduce((sum, value) => sum + value, 0);

	return {
		caseId: evalCase.id,
		dryRun,
		model,
		skillInvocations: Array.from(skillInvocations).sort(),
		skillAttempts: Array.from(skillAttempts).sort(),
		refInvocations: Array.from(refInvocations).sort(),
		refAttempts: Array.from(refAttempts).sort(),
		outputText: outputChunks.join("\n").trim(),
		tokens: tokenTotals,
		durationMs,
		errors,
		timings,
	};
};

const runCaseReuse = async (
	evalCase: EvalCase,
	skillMap: Map<string, SkillInfo>,
	model: ModelSpec,
	agentDir: string,
	dryRun: boolean,
	mode: "single" | "baseline" | "interference",
	pool: ReusePool,
	skillSetOverride?: string[],
	verbose = false,
	trace = false,
	thinkingLevel = "medium",
): Promise<CaseEvaluation> => {
	const baseSkillSet = skillSetOverride ?? evalCase.skillSet ?? Array.from(skillMap.keys());
	const { paths, missing } = resolveSkillPaths(baseSkillSet, skillMap);
	if (missing.length > 0) {
		return buildCaseResult(
			evalCase.id,
			mode,
			buildStubResult(evalCase.id, dryRun, [`missing skills: ${missing.join(", ")}`]),
			evalCase,
			[`missing skills: ${missing.join(", ")}`],
		);
	}

	const caseLabel = `${evalCase.id}${mode === "single" ? "" : ` ${mode}`}`;
	const logger = createCaseLogger(caseLabel, verbose, trace);
	const tools = resolveTools(evalCase);
	const sandbox = resolveSandbox(evalCase, dryRun);
	logCaseMetadata(logger, {
		evalCase,
		mode,
		dryRun,
		thinkingLevel,
		skillSet: baseSkillSet,
		reuse: true,
		tools,
		sandbox,
	});

	try {
		const client = await pool.getClient(baseSkillSet, paths);
		const result = await runCaseWithClient({ client, evalCase, model, agentDir, dryRun, logger });
		result.workspaceDir = null;
		return await evaluateCase(evalCase, result, mode);
	} catch (error) {
		return buildCaseResult(
			evalCase.id,
			mode,
			buildStubResult(
				evalCase.id,
				dryRun,
				[`run error: ${error instanceof Error ? error.message : String(error)}`],
			),
			evalCase,
			[`run error: ${error instanceof Error ? error.message : String(error)}`],
		);
	}
};

const runMatrixCaseReuse = async (params: {
	evalCase: EvalCase;
	skillMap: Map<string, SkillInfo>;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	pool: ReusePool;
	verbose: boolean;
	trace: boolean;
	thinkingLevel: string;
}): Promise<MatrixEvaluation> => {
	const { evalCase, skillMap, model, agentDir, dryRun, pool, verbose, trace, thinkingLevel } = params;
	const baselineSkills = evalCase.expectedSkills ?? [];
	const interferenceSkills = evalCase.skillSet ?? baselineSkills;

	const baseline = await runCaseReuse(
		evalCase,
		skillMap,
		model,
		agentDir,
		dryRun,
		"baseline",
		pool,
		baselineSkills,
		verbose,
		trace,
		thinkingLevel,
	);
	const interference = await runCaseReuse(
		evalCase,
		skillMap,
		model,
		agentDir,
		dryRun,
		"interference",
		pool,
		interferenceSkills,
		verbose,
		trace,
		thinkingLevel,
	);

	const targetSkills = evalCase.expectedSkills ?? [];
	const baselineInvoked = baseline.result.dryRun ? baseline.result.skillAttempts : baseline.result.skillInvocations;
	const interferenceInvoked =
		interference.result.dryRun ? interference.result.skillAttempts : interference.result.skillInvocations;
	const baselineTargetHits = baselineInvoked.filter((skill) => targetSkills.includes(skill)).length;
	const interferenceTargetHits = interferenceInvoked.filter((skill) => targetSkills.includes(skill)).length;
	const baselineFalsePos = baselineInvoked.filter((skill) => !targetSkills.includes(skill)).length;
	const interferenceFalsePos = interferenceInvoked.filter((skill) => !targetSkills.includes(skill)).length;
	const targetTotal = targetSkills.length || 0;

	const deltaSummary =
		targetTotal > 0
			? `targets ${baselineTargetHits}/${targetTotal} → ${interferenceTargetHits}/${targetTotal}, false positives ${baselineFalsePos} → ${interferenceFalsePos}`
			: `false positives ${baselineFalsePos} → ${interferenceFalsePos}`;

	return { evalCase, baseline, interference, deltaSummary };
};

const runCase = async (
	evalCase: EvalCase,
	skillMap: Map<string, SkillInfo>,
	model: ModelSpec,
	agentDir: string,
	dryRun: boolean,
	thinkingLevel: string,
	mode: "single" | "baseline" | "interference",
	skillSetOverride?: string[],
	verbose = false,
	trace = false,
): Promise<CaseEvaluation> => {
	const baseSkillSet = skillSetOverride ?? evalCase.skillSet ?? Array.from(skillMap.keys());
	const { paths, missing } = resolveSkillPaths(baseSkillSet, skillMap);
	if (missing.length > 0) {
		return buildCaseResult(
			evalCase.id,
			mode,
			buildStubResult(evalCase.id, dryRun, [`missing skills: ${missing.join(", ")}`]),
			evalCase,
			[`missing skills: ${missing.join(", ")}`],
		);
	}

	const tools = resolveTools(evalCase);
	const sandbox = resolveSandbox(evalCase, dryRun);
	const caseLabel = `${evalCase.id}${mode === "single" ? "" : ` ${mode}`}`;
	const logger = createCaseLogger(caseLabel, verbose, trace);
	logCaseMetadata(logger, {
		evalCase,
		mode,
		dryRun,
		thinkingLevel,
		skillSet: baseSkillSet,
		reuse: false,
		tools,
		sandbox,
	});

	let sandboxDir: string | null = null;
	try {
		let caseAgentDir = agentDir;
		let caseCwd = agentDir;
		let caseSkillPaths = paths;
		if (sandbox) {
			sandboxDir = await createSandbox(agentDir, evalCase.id);
			caseAgentDir = sandboxDir;
			caseCwd = sandboxDir;
			caseSkillPaths = mapSkillPathsToSandbox(paths, agentDir, sandboxDir);
		}

		const result = await runCaseProcess({
			evalCase,
			skillPaths: caseSkillPaths,
			model,
			agentDir: caseAgentDir,
			cwd: caseCwd,
			dryRun,
			thinkingLevel,
			tools,
			logger,
		});
		result.workspaceDir = sandboxDir;
		return await evaluateCase(evalCase, result, mode);
	} catch (error) {
		return buildCaseResult(
			evalCase.id,
			mode,
			buildStubResult(
				evalCase.id,
				dryRun,
				[`run error: ${error instanceof Error ? error.message : String(error)}`],
			),
			evalCase,
			[`run error: ${error instanceof Error ? error.message : String(error)}`],
		);
	} finally {
		await cleanupSandbox(sandboxDir);
	}
};

const runMatrixCase = async (params: {
	evalCase: EvalCase;
	skillMap: Map<string, SkillInfo>;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	thinkingLevel: string;
	verbose: boolean;
	trace: boolean;
}): Promise<MatrixEvaluation> => {
	const { evalCase, skillMap, model, agentDir, dryRun, thinkingLevel, verbose, trace } = params;
	const baselineSkills = evalCase.expectedSkills ?? [];
	const interferenceSkills = evalCase.skillSet ?? baselineSkills;

	const baseline = await runCase(
		evalCase,
		skillMap,
		model,
		agentDir,
		dryRun,
		thinkingLevel,
		"baseline",
		baselineSkills,
		verbose,
		trace,
	);
	const interference = await runCase(
		evalCase,
		skillMap,
		model,
		agentDir,
		dryRun,
		thinkingLevel,
		"interference",
		interferenceSkills,
		verbose,
		trace,
	);

	const targetSkills = evalCase.expectedSkills ?? [];
	const baselineInvoked = baseline.result.dryRun ? baseline.result.skillAttempts : baseline.result.skillInvocations;
	const interferenceInvoked =
		interference.result.dryRun ? interference.result.skillAttempts : interference.result.skillInvocations;
	const baselineTargetHits = baselineInvoked.filter((skill) => targetSkills.includes(skill)).length;
	const interferenceTargetHits = interferenceInvoked.filter((skill) => targetSkills.includes(skill)).length;
	const baselineFalsePos = baselineInvoked.filter((skill) => !targetSkills.includes(skill)).length;
	const interferenceFalsePos = interferenceInvoked.filter((skill) => !targetSkills.includes(skill)).length;
	const targetTotal = targetSkills.length || 0;

	const deltaSummary =
		targetTotal > 0
			? `targets ${baselineTargetHits}/${targetTotal} → ${interferenceTargetHits}/${targetTotal}, false positives ${baselineFalsePos} → ${interferenceFalsePos}`
			: `false positives ${baselineFalsePos} → ${interferenceFalsePos}`;

	return { evalCase, baseline, interference, deltaSummary };
};

const reportPathFor = (agentDir: string, model: ModelSpec, date: string, sha: string): string => {
	const safeModel = `${model.provider}-${model.id}`.replace(/[^a-zA-Z0-9-_]+/g, "-");
	return path.join(agentDir, "docs", "specs", "pi-eval", "reports", date, `${safeModel}_${sha}.md`);
};

const indexPathFor = (agentDir: string): string =>
	path.join(agentDir, "docs", "specs", "pi-eval", "reports", "index.json");

const getCommitSha = async (): Promise<string> => {
	try {
		const { execSync } = await import("node:child_process");
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
};

const showUsage = () => {
	const usage = renderPanel(
		"pi eval",
		[
			"Usage:",
			"  pi eval audit --model <model> [--agent-dir <path>]",
			"  pi eval run --cases <path> [--model <model>] [--dry-run] [--thinking <level>]",
			"       [--matrix <name>] [--filter <id|suite>] [--limit <n>] [--reuse] [--profile]",
			"       [--verbose] [--trace]",
			"  pi eval smoke [--model <model>] [--dry-run] [--thinking <level>] [--verbose] [--trace]",
		].join("\n"),
	);
	console.log(usage);
};

export const registerEvalCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("eval", {
		description: "Run pi eval audits and skill invocation checks",
		handler: async (args, ctx) => {
			try {
				const tokens = tokenizeArgs(args ?? "");
				const subcommand = tokens.shift() ?? "audit";
				const { flags } = parseFlags(tokens);
				const config = await loadEvalConfig();

				const agentDirFlag = parseStringFlag("--agent-dir", flags["--agent-dir"]);
				const agentDir = resolvePath(
					agentDirFlag ?? config.defaults?.agentDir ?? ctx.cwd,
					ctx.cwd,
				);
				const modelArg = parseStringFlag("--model", flags["--model"]);
				const model = await resolveModelSpec(modelArg, ctx);
				const skillsPaths = resolveSkillsPaths(config, agentDir);
				const dryRunOverride = Boolean(flags["--dry-run"]);
				const thinkingLevel = parseStringFlag("--thinking", flags["--thinking"]) ?? "medium";
				const reuseProcess = Boolean(flags["--reuse"] ?? flags["--reuse-process"]);
				const profile = Boolean(flags["--profile"]);
				const trace = Boolean(flags["--trace"]) || process.env.PI_EVAL_TRACE === "1";
				const verbose = Boolean(flags["--verbose"]) || trace || process.env.PI_EVAL_VERBOSE === "1";

				if (subcommand === "audit") {
					await runAudit({ config, model, agentDir, skillsPaths });
					return;
				}

				if (subcommand === "run" || subcommand === "smoke") {
					await ensureModelAuth(model, ctx);
					const casesPath = await resolveCasesPath(agentDir, flags["--cases"], DEFAULT_CASES_PATH);
					const filter = parseStringFlag("--filter", flags["--filter"]);
					const limitOverride = parseLimitFlag(flags["--limit"]);
					const limit =
					limitOverride ??
					(subcommand === "smoke" ? DEFAULT_SMOKE_LIMIT : undefined);
					const matrix = flags["--matrix"] as string | boolean | undefined;

					const casesLoadStart = Date.now();
					const cases = filterCases(await loadCases(casesPath), filter, limit);
					const casesLoadMs = Date.now() - casesLoadStart;
					if (cases.length === 0) {
						console.log(`${symbols.warn} ${color.warning("No cases matched.")}`);
						return;
					}

					const reuseEnabled =
						reuseProcess &&
						!cases.some((evalCase) => {
							const dryRun = dryRunOverride
								? true
								: evalCase.dryRun ?? config.defaults?.dryRun ?? false;
							return requiresIsolatedRun(evalCase, dryRun);
						});
					if (reuseProcess && !reuseEnabled) {
						logVerbose(verbose, "Reuse: disabled (cases require isolated runs)");
					}

					const skillsLoadStart = Date.now();
					const skills = await discoverSkills(skillsPaths);
					const skillsLoadMs = Date.now() - skillsLoadStart;
					const skillMap = resolveSkillMap(skills);

					const casesPathLabel = normalizePath(path.relative(agentDir, casesPath));
					logVerbose(verbose, `Eval ${subcommand} start`);
					logVerbose(verbose, `Model: ${model.label}`);
					logVerbose(verbose, `Agent dir: ${agentDir}`);
					logVerbose(verbose, `Cases path: ${casesPathLabel} (${cases.length} cases)`);
					logVerbose(verbose, `Cases load: ${formatDuration(casesLoadMs)}`);
					logVerbose(verbose, `Skills load: ${formatDuration(skillsLoadMs)}`);
					if (filter) {
						logVerbose(verbose, `Filter: ${filter}`);
					}
					if (limit) {
						logVerbose(verbose, `Limit: ${limit}`);
					}
					logVerbose(verbose, `Matrix: ${matrix ? String(matrix) : "off"}`);
					logVerbose(verbose, `Reuse: ${reuseEnabled ? "on" : "off"}`);
					logVerbose(verbose, `Thinking: ${thinkingLevel}`);
					logVerbose(verbose, `Trace: ${trace ? "on" : "off"}`);
					logVerbose(
						verbose,
						`Dry-run: ${dryRunOverride ? "forced on" : config.defaults?.dryRun ? "default on" : "off"}`,
					);
					if (skillsPaths.length > 0) {
						logVerboseBlock(
							verbose,
							"Skill paths",
							skillsPaths.map((item) => normalizePath(path.relative(agentDir, item))).join("\n"),
						);
					}
					if (skills.length > 0) {
						logVerboseBlock(
							verbose,
							`Skills (${skills.length})`,
							skills.map((skill) => skill.name).join("\n"),
						);
					}

				if (profile) {
					console.log(
						renderPanel(
							"Pi Eval Profiling",
							[
								`${color.accent("Cases load")}: ${formatDuration(casesLoadMs)}`,
								`${color.accent("Skills load")}: ${formatDuration(skillsLoadMs)}`,
								`${color.accent("Reuse")}: ${reuseEnabled ? "on" : "off"}`,
							].join("\n"),
						),
					);
					console.log("");
				}

					const runStart = Date.now();
					const evaluations: CaseEvaluation[] = [];
					const matrixResults: MatrixEvaluation[] = [];
					const profileTotals: number[] = [];

				console.log(
					renderPanel(
						"Pi Eval Run",
						`${color.accent("Cases")}: ${cases.length}${reuseEnabled ? " (reuse)" : ""}`,
					),
				);
				console.log("");

				if (reuseEnabled) {
					const pool = new ReusePool(agentDir, model, thinkingLevel);
					try {
						for (const evalCase of cases) {
							const dryRun = dryRunOverride ? true : evalCase.dryRun ?? config.defaults?.dryRun ?? false;
							if (matrix) {
								const matrixResult = await runMatrixCaseReuse({
									evalCase,
									skillMap,
									model,
									agentDir,
									dryRun,
									pool,
									verbose,
									trace,
									thinkingLevel,
								});
								matrixResults.push(matrixResult);
								evaluations.push(matrixResult.baseline, matrixResult.interference);
								console.log(
									`${matrixResult.baseline.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id} baseline`,
								);
								console.log(
									`${matrixResult.interference.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id} interference`,
								);
								if (profile) {
									logCaseProfile(`${evalCase.id} baseline`, matrixResult.baseline.result.timings);
									logCaseProfile(`${evalCase.id} interference`, matrixResult.interference.result.timings);
									if (matrixResult.baseline.result.timings?.totalMs) {
										profileTotals.push(matrixResult.baseline.result.timings.totalMs);
									}
									if (matrixResult.interference.result.timings?.totalMs) {
										profileTotals.push(matrixResult.interference.result.timings.totalMs);
									}
								}
							} else {
								const evaluation = await runCaseReuse(
									evalCase,
									skillMap,
									model,
									agentDir,
									dryRun,
									"single",
									pool,
									undefined,
									verbose,
									trace,
									thinkingLevel,
								);
								evaluations.push(evaluation);
								console.log(
									`${evaluation.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id}`,
								);
								if (profile) {
									logCaseProfile(evalCase.id, evaluation.result.timings);
									if (evaluation.result.timings?.totalMs) {
										profileTotals.push(evaluation.result.timings.totalMs);
									}
								}
							}
						}
					} finally {
						await pool.closeAll();
					}
				} else {
					for (const evalCase of cases) {
						const dryRun = dryRunOverride ? true : evalCase.dryRun ?? config.defaults?.dryRun ?? false;
						if (matrix) {
							const matrixResult = await runMatrixCase({
								evalCase,
								skillMap,
								model,
								agentDir,
								dryRun,
								thinkingLevel,
								verbose,
								trace,
							});
							matrixResults.push(matrixResult);
							evaluations.push(matrixResult.baseline, matrixResult.interference);
							console.log(
								`${matrixResult.baseline.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id} baseline`,
							);
							console.log(
								`${matrixResult.interference.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id} interference`,
							);
							if (profile) {
								logCaseProfile(`${evalCase.id} baseline`, matrixResult.baseline.result.timings);
								logCaseProfile(`${evalCase.id} interference`, matrixResult.interference.result.timings);
								if (matrixResult.baseline.result.timings?.totalMs) {
									profileTotals.push(matrixResult.baseline.result.timings.totalMs);
								}
								if (matrixResult.interference.result.timings?.totalMs) {
									profileTotals.push(matrixResult.interference.result.timings.totalMs);
								}
							}
						} else {
							const evaluation = await runCase(
								evalCase,
								skillMap,
								model,
								agentDir,
								dryRun,
								thinkingLevel,
								"single",
								undefined,
								verbose,
								trace,
							);
							evaluations.push(evaluation);
							console.log(
								`${evaluation.status === "pass" ? symbols.ok : symbols.fail} ${evalCase.id}`,
							);
							if (profile) {
								logCaseProfile(evalCase.id, evaluation.result.timings);
								if (evaluation.result.timings?.totalMs) {
									profileTotals.push(evaluation.result.timings.totalMs);
								}
							}
						}
					}
				}

				console.log("");
				console.log(buildCaseTable(evaluations));
				console.log("");

				if (profile && profileTotals.length > 0) {
					const avg = Math.round(
						profileTotals.reduce((sum, value) => sum + value, 0) / profileTotals.length,
					);
					console.log(
						renderPanel(
							"Pi Eval Profiling Summary",
							`${color.accent("Avg case")}: ${formatDuration(avg)}`,
						),
					);
					console.log("");
				}

				const durationMs = Date.now() - runStart;
				renderRunSummary(evaluations, durationMs);

				const commitSha = await getCommitSha();
				const date = new Date().toISOString().split("T")[0] ?? "unknown-date";
				const reportPath = reportPathFor(agentDir, model, date, commitSha);
				const indexPath = indexPathFor(agentDir);
				const reportContent = buildReport({
					model,
					commitSha,
					runTimestamp: new Date().toISOString(),
					evaluations,
					matrix: matrixResults,
					durationMs,
				});

				await writeReport(reportPath, reportContent);
				await updateIndex(indexPath, model.key, { sha: commitSha, timestamp: new Date().toISOString() });
				renderReportNotice(reportPath, indexPath);
				return;
			}

			showUsage();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`${symbols.fail} ${color.error(message)}`);
		}
		},
	});
};
