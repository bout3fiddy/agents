import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import path from "node:path";
import { ensureModelAuth, modelSpecFromKey, resolveModelSpec } from "../runtime/model-registry.js";
import type { EvalConfig, EvalRunOptions } from "../data/types.js";
import { fileExists, normalizePath, parsePositiveInt, resolvePath } from "../data/utils.js";
import {
	assertAllowedFlags,
	parseLimitFlag,
	parseStringFlag,
	resolveCasesPath,
} from "./validation.js";

const DEFAULT_CASES_PATH = "skills-evals/fixtures/eval-cases";
const DEFAULT_CASE_PARALLELISM = 10;

type EvalFlags = Record<string, string | boolean>;

const ALLOWED_RUN_FLAGS = [
	"--agent-dir",
	"--model",
	"--cases",
	"--filter",
	"--limit",
	"--dry-run",
	"--thinking",
] as const;

const parsePositiveIntEnv = (value: string | undefined, fallback: number): number =>
	parsePositiveInt(value, fallback);

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
	const caseParallelism = parsePositiveIntEnv(
		process.env.PI_EVAL_CASE_PARALLELISM,
		DEFAULT_CASE_PARALLELISM,
	);
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
	};
};
