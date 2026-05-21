import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { ensureModelAuth, modelSpecFromKey, resolveModelSpec } from "../runtime/model/model-registry.js";
import type { EvalConfig, EvalRunOptions } from "../data/types.js";
import { fileExists, parsePositiveInt, resolvePath } from "../data/utils.js";
import { normalizePath } from "../runtime/policy/path-policy.js";
import { fileURLToPath } from "node:url";
import {
	assertAllowedFlags,
	parseLimitFlag,
	parseParallelismFlag,
	parseStringFlag,
	resolveCasesPath,
} from "./validation.js";

const DEFAULT_CASES_PATH = "skills-evals/fixtures/eval-cases";
const MAX_CASE_PARALLELISM = 6;

type EvalFlags = Record<string, string | boolean>;

const ALLOWED_RUN_FLAGS = [
	"--agent-dir",
	"--model",
	"--cases",
	"--filter",
	"--limit",
	"--parallelism",
	"--dry-run",
	"--thinking",
] as const;

const parsePositiveIntEnv = (value: string | undefined, fallback: number): number =>
	parsePositiveInt(value, fallback);

export const resolveCaseParallelism = (params: {
	flagValue?: string | boolean;
	envValue?: string;
	availableWorkers?: number;
}): number => {
	const availableWorkers = Math.max(1, Math.floor(params.availableWorkers ?? availableParallelism()));
	const defaultParallelism = Math.min(availableWorkers, MAX_CASE_PARALLELISM);
	const fromFlag = parseParallelismFlag(params.flagValue);
	const requested = fromFlag ?? parsePositiveIntEnv(params.envValue, defaultParallelism);
	return Math.max(1, Math.min(requested, availableWorkers, MAX_CASE_PARALLELISM));
};

export const isSameResolvedPath = (left: string, right: string): boolean =>
	normalizePath(path.resolve(left)) === normalizePath(path.resolve(right));

export const validateRunMode = (positionals: string[]): void => {
	if (positionals.length === 0) return;
	if (positionals[0] !== "run") {
		throw new Error(`Unsupported eval mode: ${positionals[0]}. Only 'run' is supported.`);
	}
	if (positionals.length > 1) {
		throw new Error(`Unexpected positional args: ${positionals.slice(1).join(" ")}`);
	}
};

export const resolveRunOptions = async (
	flags: EvalFlags,
	ctx: ExtensionCommandContext,
	config: EvalConfig,
): Promise<EvalRunOptions> => {
	assertAllowedFlags(flags, ALLOWED_RUN_FLAGS);
	const agentDirFlag = parseStringFlag("--agent-dir", flags["--agent-dir"]);
	const agentDir = resolvePath(agentDirFlag ?? config.defaults?.agentDir ?? ctx.cwd, ctx.cwd);
	const model = await resolveModelSpec(parseStringFlag("--model", flags["--model"]), config, ctx);
	await ensureModelAuth(model, ctx);

	const casesPath = await resolveCasesPath(agentDir, flags["--cases"], DEFAULT_CASES_PATH);
	const defaultCasesPath = await resolveCasesPath(agentDir, undefined, DEFAULT_CASES_PATH);
	const filter = parseStringFlag("--filter", flags["--filter"]);
	const limitOverride = parseLimitFlag(flags["--limit"]);
	const dryRunOverride = Boolean(flags["--dry-run"]);
	const thinkingLevel = parseStringFlag("--thinking", flags["--thinking"]) ?? "medium";
	const caseParallelism = resolveCaseParallelism({
		flagValue: flags["--parallelism"],
		envValue: process.env.PI_EVAL_CASE_PARALLELISM,
	});
	const authSourcePath =
		process.env.PI_EVAL_AUTH_SOURCE ?? path.join(homedir(), ".pi", "agent", "auth.json");
	const evalAuthSource = (await fileExists(authSourcePath)) ? authSourcePath : null;

	const isDefaultCasesPath = isSameResolvedPath(casesPath, defaultCasesPath);
	const isFullRun = !filter && !limitOverride && isDefaultCasesPath;
	const casesPathLabel = normalizePath(path.relative(agentDir, casesPath));

	const judgeModelEnv = process.env.PI_EVAL_JUDGE_MODEL?.trim() ?? "";
	const judgeThinkingEnv = process.env.PI_EVAL_JUDGE_THINKING?.trim() ?? "";
	const judgeDisabled = judgeModelEnv === "false";
	const judgeModel =
		!judgeDisabled && judgeModelEnv.includes("/") ? modelSpecFromKey(judgeModelEnv) : null;
	const judgeThinking = judgeThinkingEnv.length > 0 ? judgeThinkingEnv : thinkingLevel;

	const judgeAgentsPath = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"config",
		"judge",
		"AGENTS.md",
	);
	if (!judgeDisabled && !(await fileExists(judgeAgentsPath))) {
		throw new Error(`Judge AGENTS.md not found: ${judgeAgentsPath}`);
	}

	return {
		agentDir,
		model,
		casesPath,
		defaultCasesPath,
		filter,
		limitOverride,
		dryRunOverride,
		thinkingLevel,
		caseParallelism,
		evalAuthSource,
		isFullRun,
		casesPathLabel,
		judgeModel,
		judgeThinking,
		judgeDisabled,
		judgeAgentsPath,
	};
};
