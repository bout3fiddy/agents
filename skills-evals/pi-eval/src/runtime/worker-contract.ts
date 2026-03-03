import type { BootstrapProfile } from "../data/types.js";

const WORKER_ENV_KEYS = {
	mode: "PI_EVAL_WORKER",
	outputPath: "PI_EVAL_OUTPUT",
	caseId: "PI_EVAL_CASE_ID",
	dryRun: "PI_EVAL_DRY_RUN",
	turns: "PI_EVAL_TURNS",
	agentDir: "PI_EVAL_AGENT_DIR",
	allowedTools: "PI_EVAL_ALLOWED_TOOLS",
	readDenyPaths: "PI_EVAL_READ_DENY_PATHS",
	bootstrapProfile: "PI_EVAL_BOOTSTRAP_PROFILE",
	availableSkills: "PI_EVAL_AVAILABLE_SKILLS",
	bootstrapManifestHash: "PI_EVAL_BOOTSTRAP_MANIFEST_HASH",
} as const;

const DEFAULT_READ_DENY_PATHS = [
	"skills-evals/fixtures/eval-cases.jsonl",
	"skills-evals/reports",
	"docs/specs/pi-eval/reports",
];

export const DEFAULT_ALLOWED_TOOLS = ["read"];

export type WorkerLaunchConfig = {
	outputPath: string;
	caseId: string;
	dryRun: boolean;
	turnCount: number;
	agentDir: string;
	allowedTools: string[];
	readDenyPaths: string[];
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string | null;
	homeDir?: string | null;
};

export const mergeReadDenyPaths = (extraPaths?: string[]): string[] => {
	const merged = new Set<string>(DEFAULT_READ_DENY_PATHS);
	for (const item of extraPaths ?? []) {
		if (typeof item === "string" && item.trim().length > 0) merged.add(item);
	}
	return Array.from(merged);
};

export const buildWorkerEnv = (
	config: WorkerLaunchConfig,
	baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
	...baseEnv,
	[WORKER_ENV_KEYS.mode]: "1",
	[WORKER_ENV_KEYS.outputPath]: config.outputPath,
	[WORKER_ENV_KEYS.caseId]: config.caseId,
	[WORKER_ENV_KEYS.dryRun]: config.dryRun ? "1" : "0",
	[WORKER_ENV_KEYS.turns]: String(config.turnCount),
	[WORKER_ENV_KEYS.agentDir]: config.agentDir,
	[WORKER_ENV_KEYS.allowedTools]: config.allowedTools.join(","),
	[WORKER_ENV_KEYS.readDenyPaths]: JSON.stringify(config.readDenyPaths),
	[WORKER_ENV_KEYS.bootstrapProfile]: config.bootstrapProfile,
	[WORKER_ENV_KEYS.availableSkills]: JSON.stringify(config.availableSkills),
	[WORKER_ENV_KEYS.bootstrapManifestHash]: config.bootstrapManifestHash ?? "",
	...(config.homeDir
		? {
			HOME: config.homeDir,
			PI_CODING_AGENT_DIR: `${config.homeDir}/.agents`,
		}
		: {}),
});

const parseJsonArray = (raw: string | undefined): string[] => {
	if (!raw) return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((item): item is string => typeof item === "string");
};

const parseAllowedTools = (raw: string | undefined): Set<string> => {
	const allowed = (raw ?? DEFAULT_ALLOWED_TOOLS.join(","))
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	return new Set(allowed);
};

const parseExpectedTurns = (raw: string | undefined): number => {
	const value = Number.parseInt(raw ?? "1", 10);
	return Number.isFinite(value) && value > 0 ? value : 1;
};

const parseBootstrapProfile = (raw: string | undefined): BootstrapProfile => {
	if (raw === "no_payload") return "no_payload";
	return "full_payload";
};

export type WorkerRuntimeConfig = {
	outputPath: string;
	caseId: string;
	dryRun: boolean;
	expectedTurns: number;
	agentDir: string;
	allowedTools: Set<string>;
	readDenyPaths: string[];
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string | null;
};

export const parseWorkerRuntimeConfig = (
	env: NodeJS.ProcessEnv,
	cwd: string,
): WorkerRuntimeConfig | null => {
	if (env[WORKER_ENV_KEYS.mode] !== "1") return null;
	const outputPath = env[WORKER_ENV_KEYS.outputPath];
	if (!outputPath) throw new Error(`${WORKER_ENV_KEYS.outputPath} is required in worker mode`);
	return {
		outputPath,
		caseId: env[WORKER_ENV_KEYS.caseId] ?? "unknown",
		dryRun: env[WORKER_ENV_KEYS.dryRun] === "1",
		expectedTurns: parseExpectedTurns(env[WORKER_ENV_KEYS.turns]),
		agentDir: env[WORKER_ENV_KEYS.agentDir] ?? cwd,
		allowedTools: parseAllowedTools(env[WORKER_ENV_KEYS.allowedTools]),
		readDenyPaths: mergeReadDenyPaths(parseJsonArray(env[WORKER_ENV_KEYS.readDenyPaths])),
		bootstrapProfile: parseBootstrapProfile(env[WORKER_ENV_KEYS.bootstrapProfile]),
		availableSkills: parseJsonArray(env[WORKER_ENV_KEYS.availableSkills]),
		bootstrapManifestHash: env[WORKER_ENV_KEYS.bootstrapManifestHash] || null,
	};
};
