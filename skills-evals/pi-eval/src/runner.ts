import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { tokenizeArgs, parseFlags } from "./args.js";
import { parseLimitFlag, parseStringFlag, resolveCasesPath } from "./validation.js";
import { runAudit } from "./audit.js";
import { loadCases, filterCases } from "./cases.js";
import { loadEvalConfig } from "./config.js";
import { color, renderPanel, renderTable, symbols } from "./logger.js";
import { buildReport, readReportRows, renderReportNotice, updateIndex, writeReport } from "./report.js";
import {
	createSandbox,
	createSharedCaseWorkspace,
	createSandboxHome,
	cleanupSandbox,
	cleanupSandboxHome,
	mapSkillPathsToSandbox,
	runEvalSync,
} from "./sandbox.js";
import { buildCaseResult, evaluateCase } from "./scoring.js";
import { discoverSkills } from "./skills.js";
import type {
	CaseEvaluation,
	CaseRunResult,
	EvalCase,
	EvalConfig,
	ModelSpec,
	SkillInfo,
} from "./types.js";
import { fileExists, formatDuration, normalizePath, resolvePath } from "./utils.js";

type IndexedCase = { index: number; evalCase: EvalCase };
type CaseExecution = { index: number; evaluation: CaseEvaluation };
type CasePlan = {
	id: string;
	suite: string;
	mode: "batch" | "single";
	cases: IndexedCase[];
};

const DEFAULT_CASES_PATH = "skills-evals/fixtures/eval-cases.jsonl";
const CASE_TIMEOUT_MS = 180_000;
const DEFAULT_CASE_PARALLELISM = 10;
const DEFAULT_SHARED_CASE_MUTABLE_PATHS = ["skills-evals/fixtures"];

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

const modelSpecFromKey = (modelKey: string): ModelSpec | null => {
	const [provider, ...idParts] = modelKey.split("/");
	const id = idParts.join("/");
	if (!provider || !id) return null;
	return {
		provider,
		id,
		key: `${provider}/${id}`,
		label: `${provider}/${id}`,
	};
};

const resolveModelSpec = async (
	modelArg: string | undefined,
	config: EvalConfig,
	ctx: ExtensionCommandContext,
): Promise<ModelSpec> => {
	let availableModels: Model<any>[] | null = null;
	const getAvailableModels = async (): Promise<Model<any>[]> => {
		if (availableModels) return availableModels;
		availableModels = await ctx.modelRegistry.getAvailable();
		return availableModels;
	};

	if (modelArg) {
		if (modelArg.includes("/")) {
			const parsed = modelSpecFromKey(modelArg);
			if (parsed) return parsed;
			throw new Error(`Invalid model format: ${modelArg}. Expected provider/model.`);
		}
		const available = await getAvailableModels();
		const match = available.find((item) => item.id === modelArg);
		if (match) return modelSpecFromModel(match);
		throw new Error(
			`Model not found: ${modelArg}. Available: ${available
				.map((item) => `${item.provider}/${item.id}`)
				.join(", ")}`,
		);
	}

	const configuredModel = config.requiredModels?.[0];
	if (typeof configuredModel === "string" && configuredModel.trim().length > 0) {
		if (configuredModel.includes("/")) {
			const parsed = modelSpecFromKey(configuredModel);
			if (parsed) return parsed;
		} else {
			const available = await getAvailableModels();
			const match = available.find((item) => item.id === configuredModel);
			if (match) return modelSpecFromModel(match);
		}
	}

	if (ctx.model) {
		return modelSpecFromModel(ctx.model);
	}

	const available = await getAvailableModels();
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

const parsePositiveIntEnv = (value: string | undefined, defaultValue: number): number => {
	const parsed = Number.parseInt(value ?? `${defaultValue}`, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error("PI_EVAL_CASE_PARALLELISM must be a positive integer.");
	}
	return parsed;
};

const parseBoolEnv = (value: string | undefined, defaultValue: boolean): boolean => {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(normalized);
};

const parsePathListEnv = (value: string | undefined, defaultValue: string[]): string[] => {
	if (!value) return defaultValue;
	const list = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return list.length > 0 ? list : defaultValue;
};

const runItemsInParallel = async <TItem, TResult>(
	items: TItem[],
	parallelism: number,
	runItem: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> => {
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const itemIndex = nextIndex;
			nextIndex += 1;
			if (itemIndex >= items.length) return;
			results[itemIndex] = await runItem(items[itemIndex]);
		}
	};

	const workerCount = Math.min(Math.max(parallelism, 1), items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
};

const runCasePlansInParallel = async (
	cases: CasePlan[],
	totalCaseCount: number,
	caseWorkerCount: number,
	runPlan: (plan: CasePlan) => Promise<CaseExecution[]>,
): Promise<CaseEvaluation[]> => {
	const evaluations = new Array<CaseEvaluation>(totalCaseCount);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const planIndex = nextIndex;
			nextIndex += 1;
			if (planIndex >= cases.length) return;

			const plan = cases[planIndex];
			const results = await runPlan(plan);
			for (const item of results) {
				evaluations[item.index] = item.evaluation;
				console.log(
					`${item.evaluation.status === "pass" ? symbols.ok : symbols.fail} ${item.evaluation.caseId}`,
				);
			}
		}
	};

	const workers = Array.from({ length: Math.min(caseWorkerCount, cases.length) }, () => worker());
	await Promise.all(workers);
	return evaluations;
};

const buildCaseTable = (evaluations: CaseEvaluation[]): string => {
	const rows = evaluations.map((item) => {
		const status = item.status === "pass" ? symbols.ok : symbols.fail;
		const tokenCount = item.result.tokens.totalTokens || 0;
		const reason = item.reasons[0] ?? "";
		return [status, item.caseId, tokenCount, reason];
	});
	return renderTable(["Status", "Case", "Tokens", "Notes"], rows);
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

const resolveCaseSkillPaths = (
	evalCase: EvalCase,
	skillMap: Map<string, SkillInfo>,
): { paths: string[]; missing: string[] } => {
	const baseSkillSet = evalCase.skillSet ?? Array.from(skillMap.keys());
	return resolveSkillPaths(baseSkillSet, skillMap);
};

const canBatchCase = (evalCase: EvalCase): boolean => {
	if (!resolveSandbox(evalCase)) return false;
	const tools = resolveTools(evalCase);
	return !tools.includes("write") && !tools.includes("edit");
};

const planCaseExecution = (cases: IndexedCase[]): CasePlan[] => {
	const plans: CasePlan[] = [];
	const suiteIndex = new Map<string, number>();
	for (const item of cases) {
		if (!canBatchCase(item.evalCase)) {
			plans.push({
				id: `single-${item.evalCase.id}-${item.index}`,
				suite: item.evalCase.suite,
				mode: "single",
				cases: [item],
			});
			continue;
		}

		const existingIndex = suiteIndex.get(item.evalCase.suite);
		if (existingIndex === undefined) {
			suiteIndex.set(item.evalCase.suite, plans.length);
			plans.push({
				id: `batch-${item.evalCase.suite}-${item.evalCase.id}`,
				suite: item.evalCase.suite,
				mode: "batch",
				cases: [],
			});
		}
		plans[suiteIndex.get(item.evalCase.suite)!].cases.push(item);
	}
	return plans;
};

const resolveSandbox = (evalCase: EvalCase): boolean => evalCase.sandbox ?? true;

const buildStubResult = (
	caseId: string,
	dryRun: boolean,
	errors: string[],
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
});

const runCaseInWorkspace = async (params: {
	evalCase: EvalCase;
	skillPaths: string[];
	model: ModelSpec;
	agentDir: string;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	globalInstructionsPath?: string | null;
	homeDir?: string | null;
}): Promise<CaseEvaluation> => {
	const {
		evalCase,
		skillPaths,
		model,
		agentDir,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		globalInstructionsPath,
		homeDir,
	} = params;

	const result = await runCaseProcess({
		evalCase,
		skillPaths,
		model,
		agentDir,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		globalInstructionsPath,
		homeDir,
	});
	result.workspaceDir = agentDir;
	return await evaluateCase(evalCase, result);
};

const runSharedCaseBatch = async (params: {
	batch: CasePlan;
	skillMap: Map<string, SkillInfo>;
	model: ModelSpec;
	sharedCaseAgentDir: string;
	sharedCaseMutablePaths: string[];
	thinkingLevel: string;
	authSourcePath?: string | null;
	resolveDryRun: (evalCase: EvalCase) => boolean;
	batchCaseParallelism: number;
}): Promise<CaseExecution[]> => {
	const {
		batch,
		skillMap,
		model,
		sharedCaseAgentDir,
		sharedCaseMutablePaths,
		thinkingLevel,
		authSourcePath,
		resolveDryRun,
		batchCaseParallelism,
	} = params;

	let sandboxDir: string | null = null;
	let sandboxHomeDir: string | null = null;
	try {
		sandboxDir = await createSharedCaseWorkspace(
			sharedCaseAgentDir,
			batch.id,
			sharedCaseMutablePaths,
		);
		sandboxHomeDir = await createSandboxHome(batch.id);
		try {
			await runEvalSync({
				agentDir: sandboxDir,
				homeDir: sandboxHomeDir,
				authSourcePath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return batch.cases.map((item) => {
				const dryRun = resolveDryRun(item.evalCase);
				return {
					index: item.index,
					evaluation: buildCaseResult(
						item.evalCase.id,
						buildStubResult(item.evalCase.id, dryRun, [`sync failed: ${message}`]),
						item.evalCase,
						[`sync failed: ${message}`],
					),
				};
			});
		}
		const caseGlobalInstructionsPath = path.join(sandboxHomeDir, ".pi", "agent", "AGENTS.md");
		const runBatchCase = async (item: IndexedCase): Promise<CaseExecution> => {
			const dryRun = resolveDryRun(item.evalCase);
			try {
				const { paths, missing } = resolveCaseSkillPaths(item.evalCase, skillMap);
				if (missing.length > 0) {
					return {
						index: item.index,
						evaluation: buildCaseResult(
							item.evalCase.id,
							buildStubResult(item.evalCase.id, dryRun, [`missing skills: ${missing.join(", ")}`]),
							item.evalCase,
							[`missing skills: ${missing.join(", ")}`],
						),
					};
				}

				const caseSkillPaths = mapSkillPathsToSandbox(paths, sharedCaseAgentDir, sandboxDir);
				const tools = resolveTools(item.evalCase);
				const result = await runCaseProcess({
					evalCase: item.evalCase,
					skillPaths: caseSkillPaths,
					model,
					agentDir: sandboxDir,
					cwd: sandboxDir,
					dryRun,
					thinkingLevel,
					tools,
					globalInstructionsPath: caseGlobalInstructionsPath,
					homeDir: sandboxHomeDir,
				});
				result.workspaceDir = sandboxDir;
				return {
					index: item.index,
					evaluation: await evaluateCase(item.evalCase, result),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					index: item.index,
					evaluation: buildCaseResult(
						item.evalCase.id,
						buildStubResult(item.evalCase.id, dryRun, [`run error: ${message}`]),
						item.evalCase,
						[`run error: ${message}`],
					),
				};
			}
		};
		const effectiveBatchCaseParallelism = Math.min(batchCaseParallelism, batch.cases.length);
		const results = await runItemsInParallel(
			batch.cases,
			effectiveBatchCaseParallelism,
			runBatchCase,
		);
		return results;
	} finally {
		await cleanupSandbox(sandboxDir);
		await cleanupSandboxHome(sandboxHomeDir);
	}
};

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

const runCaseProcess = async (params: {
	evalCase: EvalCase;
	skillPaths: string[];
	model: ModelSpec;
	agentDir: string;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	globalInstructionsPath?: string | null;
	homeDir?: string | null;
}): Promise<CaseRunResult> => {
	const {
		evalCase,
		skillPaths,
		model,
		agentDir,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		globalInstructionsPath,
		homeDir,
	} = params;

	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const outputDir = path.join(tmpdir(), "pi-eval", randomUUID());
	const outputPath = path.join(outputDir, `${evalCase.id}.json`);

	const env = {
		...process.env,
		PI_EVAL_WORKER: "1",
		PI_EVAL_OUTPUT: outputPath,
		PI_EVAL_CASE_ID: evalCase.id,
		PI_EVAL_DRY_RUN: dryRun ? "1" : "0",
		PI_EVAL_TURNS: String(prompts.length),
		PI_EVAL_AGENT_DIR: agentDir,
		...(globalInstructionsPath ? { PI_EVAL_GLOBAL_INSTRUCTIONS_PATH: globalInstructionsPath } : {}),
		...(homeDir ? { HOME: homeDir } : {}),
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
		tools.join(","),
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
	proc.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

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

		if (event.type === "response" && event.command === "prompt" && event.success === false) {
			promptError = event.error ?? "prompt rejected";
		}

		if (event.type === "agent_end") {
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
		const payload = JSON.stringify({ type: "prompt", message });
		proc.stdin?.write(`${payload}\n`);
	};

	for (const prompt of prompts) {
		sendPrompt(prompt);
		await withTimeout(waitForAgentEnd(), CASE_TIMEOUT_MS, `Case ${evalCase.id}`);
		if (promptError) break;
	}

	const closePromise = new Promise<void>((resolve, reject) => {
		proc.on("close", () => resolve());
		proc.on("error", (error) => reject(error));
	});

	const outputReady = await waitForFile(outputPath, 15_000);
	if (!proc.killed) {
		proc.kill();
	}
	await withTimeout(closePromise, 10_000, `Case ${evalCase.id} shutdown`);

	try {
		if (!outputReady) {
			return buildStubResult(
				evalCase.id,
				dryRun,
				[promptError ?? "no output from worker", ...stderrChunks.map((line) => line.trim()).filter(Boolean)],
			);
		}

		const raw = await readFile(outputPath, "utf-8");
		const result = JSON.parse(raw) as CaseRunResult;
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

const runCase = async (params: {
	evalCase: EvalCase;
	skillMap: Map<string, SkillInfo>;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	thinkingLevel: string;
	sharedCaseAgentDir?: string | null;
	sharedCaseMutablePaths?: string[];
	authSourcePath?: string | null;
}): Promise<CaseEvaluation> => {
	const {
		evalCase,
		skillMap,
		model,
		agentDir,
		dryRun,
		thinkingLevel,
		sharedCaseAgentDir,
		sharedCaseMutablePaths,
		authSourcePath,
	} = params;

	const { paths, missing } = resolveCaseSkillPaths(evalCase, skillMap);
	if (missing.length > 0) {
		return buildCaseResult(
			evalCase.id,
			buildStubResult(evalCase.id, dryRun, [`missing skills: ${missing.join(", ")}`]),
			evalCase,
			[`missing skills: ${missing.join(", ")}`],
		);
	}

	const tools = resolveTools(evalCase);
	const sandbox = resolveSandbox(evalCase);
	let sandboxDir: string | null = null;
	let sandboxHomeDir: string | null = null;
	try {
		let caseAgentDir = agentDir;
		let caseCwd = agentDir;
		let caseSkillPaths = paths;
		if (sandbox) {
			if (sharedCaseAgentDir) {
				sandboxDir = await createSharedCaseWorkspace(
					sharedCaseAgentDir,
					evalCase.id,
					sharedCaseMutablePaths ?? DEFAULT_SHARED_CASE_MUTABLE_PATHS,
				);
			} else {
				sandboxDir = await createSandbox(agentDir, evalCase.id);
			}
			caseAgentDir = sandboxDir;
			caseCwd = sandboxDir;
			caseSkillPaths = mapSkillPathsToSandbox(
				paths,
				sharedCaseAgentDir ?? agentDir,
				sandboxDir,
			);
		}

		sandboxHomeDir = await createSandboxHome(evalCase.id);
		await runEvalSync({
			agentDir: caseAgentDir,
			homeDir: sandboxHomeDir,
			authSourcePath,
		});
		const caseGlobalInstructionsPath = path.join(sandboxHomeDir, ".pi", "agent", "AGENTS.md");
		const result = await runCaseInWorkspace({
			evalCase,
			skillPaths: caseSkillPaths,
			model,
			agentDir: caseAgentDir,
			cwd: caseCwd,
			dryRun,
			thinkingLevel,
			tools,
			globalInstructionsPath: caseGlobalInstructionsPath,
			homeDir: sandboxHomeDir,
		});
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildCaseResult(
			evalCase.id,
			buildStubResult(evalCase.id, dryRun, [`run error: ${message}`]),
			evalCase,
			[`run error: ${message}`],
		);
	} finally {
		await cleanupSandbox(sandboxDir);
		await cleanupSandboxHome(sandboxHomeDir);
	}
};

const reportRootFor = (agentDir: string): string =>
	path.join(agentDir, "skills-evals", "reports");

const reportMirrorRootsFor = (agentDir: string): string[] => [
	path.join(agentDir, "docs", "specs", "pi-eval", "reports"),
];

const reportPathFor = (reportRoot: string, model: ModelSpec): string => {
	const safeModel = `${model.provider}-${model.id}`.replace(/[^a-zA-Z0-9-_]+/g, "-");
	return path.join(reportRoot, `${safeModel}.md`);
};

const indexPathFor = (reportRoot: string): string =>
	path.join(reportRoot, "index.json");

const allReportRootsFor = (agentDir: string): string[] => [
	reportRootFor(agentDir),
	...reportMirrorRootsFor(agentDir),
];

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
			"       [--filter <id|suite>] [--limit <n>]",
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
				const model = await resolveModelSpec(modelArg, config, ctx);
				const skillsPaths = resolveSkillsPaths(config, agentDir);

				if (flags["--reuse"] || flags["--reuse-process"]) {
					throw new Error(
						"Flag --reuse was removed. Use PI_EVAL_CASE_PARALLELISM and shared sandbox controls instead.",
					);
				}
				if (flags["--matrix"]) {
					throw new Error("Flag --matrix is not supported in minimal eval mode.");
				}
				if (flags["--jobs"]) {
					throw new Error("Flag --jobs is not supported in minimal eval mode.");
				}
				if (flags["--profile"] || flags["--trace"] || flags["--verbose"]) {
					throw new Error("Flags --profile/--trace/--verbose are not supported in minimal eval mode.");
				}

				if (subcommand === "audit") {
					await runAudit({ config, model, agentDir, skillsPaths });
					return;
				}

				if (subcommand !== "run") {
					showUsage();
					return;
				}

				await ensureModelAuth(model, ctx);
				const casesPath = await resolveCasesPath(agentDir, flags["--cases"], DEFAULT_CASES_PATH);
				const defaultCasesPath = await resolveCasesPath(agentDir, undefined, DEFAULT_CASES_PATH);
				const authSourcePath =
					process.env.PI_EVAL_AUTH_SOURCE ??
					path.join(homedir(), ".pi", "agent", "auth.json");
				const authSourceAvailable = await fileExists(authSourcePath);
				const evalAuthSource = authSourceAvailable ? authSourcePath : null;
				const filter = parseStringFlag("--filter", flags["--filter"]);
				const limitOverride = parseLimitFlag(flags["--limit"]);
				const dryRunOverride = Boolean(flags["--dry-run"]);
				const thinkingLevel = parseStringFlag("--thinking", flags["--thinking"]) ?? "medium";
				const caseParallelism = parsePositiveIntEnv(
					process.env.PI_EVAL_CASE_PARALLELISM,
					DEFAULT_CASE_PARALLELISM,
				);
				const batchCaseParallelism = parsePositiveIntEnv(
					process.env.PI_EVAL_BATCH_CASE_PARALLELISM,
					caseParallelism,
				);
				const useSharedCaseSandbox = parseBoolEnv(
					process.env.PI_EVAL_SHARED_CASE_SANDBOX,
					true,
				);
				const sharedCaseMutablePaths = parsePathListEnv(
					process.env.PI_EVAL_SHARED_CASE_MUTABLE_PATHS,
					DEFAULT_SHARED_CASE_MUTABLE_PATHS,
				);
				let sharedCaseAgentDir: string | null = null;

				const casesPathResolved = normalizePath(path.resolve(casesPath));
				const defaultCasesResolved = normalizePath(path.resolve(defaultCasesPath));
				const isDefaultCasesPath = casesPathResolved === defaultCasesResolved;
				const isFullRun = !filter && !limitOverride && isDefaultCasesPath;

				const defaultCases = await loadCases(defaultCasesPath);
				const selectedCases = isDefaultCasesPath ? defaultCases : await loadCases(casesPath);
				const allCases = defaultCases;
				const cases = filterCases(selectedCases, filter, limitOverride);
				if (cases.length === 0) {
					console.log(`${symbols.warn} ${color.warning("No cases matched.")}`);
					return;
				}
				const useSharedCaseSandboxForRun =
					useSharedCaseSandbox && cases.some((evalCase) => resolveSandbox(evalCase));

				const skills = await discoverSkills(skillsPaths);
				const skillMap = resolveSkillMap(skills);
				const runStart = Date.now();

				console.log(renderPanel("Pi Eval Run", `${color.accent("Cases")}: ${cases.length}`));
				console.log(`${color.accent("Parallelism")}: ${caseParallelism} case(s)`);
				console.log(`${color.accent("Batch parallelism")}: ${batchCaseParallelism} case(s)`);
				console.log("");

				try {
					if (useSharedCaseSandboxForRun) {
						sharedCaseAgentDir = await createSandbox(agentDir, "shared-case");
						console.log(
							`${color.muted(`Using shared case sandbox: ${path.basename(sharedCaseAgentDir)}`)}`,
						);
					}

					const indexedCases = cases.map((evalCase, index) => ({ index, evalCase }));
					const executionPlans = useSharedCaseSandboxForRun ? planCaseExecution(indexedCases) : indexedCases.map(
						(item) => ({
							id: `single-${item.evalCase.id}-${item.index}`,
							suite: item.evalCase.suite,
							mode: "single",
							cases: [item],
						} satisfies CasePlan),
					);

					const resolveDryRun = (item: EvalCase) =>
						dryRunOverride ? true : item.dryRun ?? config.defaults?.dryRun ?? false;

					const evaluations = await runCasePlansInParallel(
						executionPlans,
						cases.length,
						caseParallelism,
						async (plan) => {
							if (plan.mode === "batch") {
								if (!sharedCaseAgentDir) {
									throw new Error("Shared case sandbox was not prepared.");
								}
									return runSharedCaseBatch({
										batch: plan,
										skillMap,
										model,
										sharedCaseAgentDir,
										sharedCaseMutablePaths,
										thinkingLevel,
										authSourcePath: evalAuthSource,
										resolveDryRun,
										batchCaseParallelism,
									});
								}

							const item = plan.cases[0];
							const dryRun = resolveDryRun(item.evalCase);
							const evaluation = await runCase({
								evalCase: item.evalCase,
								skillMap,
								model,
								agentDir,
								dryRun,
								thinkingLevel,
								sharedCaseAgentDir,
								sharedCaseMutablePaths,
								authSourcePath: evalAuthSource,
							});
							return [{ index: item.index, evaluation }];
						},
					);

					console.log("");
					console.log(buildCaseTable(evaluations));
					console.log("");

					const durationMs = Date.now() - runStart;
					renderRunSummary(evaluations, durationMs);

					const commitSha = await getCommitSha();
					const reportRoots = allReportRootsFor(agentDir);
					const reportPath = reportPathFor(reportRoots[0], model);
					const indexPath = indexPathFor(reportRoots[0]);
					const mirrorReportPaths = reportRoots.slice(1).map((root) => reportPathFor(root, model));
					const mirrorIndexPaths = reportRoots.slice(1).map((root) => indexPathFor(root));
					const runTimestamp = new Date().toISOString();
					const previousRows = await readReportRows(reportPath);
					const reportContent = buildReport({
						model,
						commitSha,
						runTimestamp,
						evaluations,
						durationMs,
						allCases,
						previousRows,
						runScope: isFullRun ? "full" : "partial",
						filter,
						limit: limitOverride,
						casesPathLabel: normalizePath(path.relative(agentDir, casesPath)),
					});

					await writeReport(reportPath, reportContent);
					for (const mirrorPath of mirrorReportPaths) {
						await writeReport(mirrorPath, reportContent);
					}
					if (isFullRun) {
						await updateIndex(indexPath, model.key, { sha: commitSha, timestamp: runTimestamp });
						for (const mirrorIndexPath of mirrorIndexPaths) {
							await updateIndex(mirrorIndexPath, model.key, {
								sha: commitSha,
								timestamp: runTimestamp,
							});
						}
					}
					renderReportNotice(reportPath, indexPath, { indexUpdated: isFullRun });
					for (const mirrorPath of mirrorReportPaths) {
						console.log(color.success(`Report written: ${mirrorPath}`));
					}
					for (const mirrorIndexPath of mirrorIndexPaths) {
						if (isFullRun) {
							console.log(color.muted(`Index updated: ${mirrorIndexPath}`));
						} else {
							console.log(color.warning(`Index not updated (partial run): ${mirrorIndexPath}`));
						}
					}
				} finally {
					await cleanupSandbox(sharedCaseAgentDir);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`${symbols.fail} ${color.error(message)}`);
			}
		},
	});
};
