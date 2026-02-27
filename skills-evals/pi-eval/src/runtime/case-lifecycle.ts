import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
	createSandbox,
	createSandboxHome,
	cleanupSandbox,
	cleanupSandboxHome,
	mapSkillPathsToSandbox,
	runEvalSync,
} from "./sandbox.js";
import { buildCaseResult, evaluateCase } from "./scoring.js";
import type { CaseEvaluation, EvalCase, ModelSpec, SkillInfo } from "../data/types.js";
import { DEFAULT_ALLOWED_TOOLS } from "./worker-contract.js";
import { buildStubResult, runCaseProcess } from "./case-process.js";

type CaseWorkspace = {
	agentDir: string;
	cwd: string;
	skillPaths: string[];
	sandboxDir: string | null;
};

const resolveSkillPaths = (
	evalCase: EvalCase,
	skillMap: Map<string, SkillInfo>,
): { paths: string[]; missing: string[] } => {
	const missing: string[] = [];
	const paths: string[] = [];
	for (const name of evalCase.skillSet ?? []) {
		const skill = skillMap.get(name);
		if (!skill) {
			missing.push(name);
			continue;
		}
		paths.push(skill.skillFile);
	}
	return { paths, missing };
};

const resolveTools = (evalCase: EvalCase): string[] =>
	evalCase.tools && evalCase.tools.length > 0 ? [...evalCase.tools] : [...DEFAULT_ALLOWED_TOOLS];

export const buildErrorEvaluation = (
	evalCase: EvalCase,
	dryRun: boolean,
	errorMessage: string,
): CaseEvaluation =>
	buildCaseResult(
		evalCase.id,
		buildStubResult(evalCase.id, dryRun, [errorMessage]),
		evalCase,
		[errorMessage],
	);

const setupCaseWorkspace = async (
	evalCase: EvalCase,
	agentDir: string,
	skillPaths: string[],
): Promise<CaseWorkspace> => {
	if (evalCase.sandbox === false) {
		return { agentDir, cwd: agentDir, skillPaths, sandboxDir: null };
	}
	const sandboxDir = await createSandbox(agentDir, evalCase.id);
	return {
		agentDir: sandboxDir,
		cwd: sandboxDir,
		skillPaths: mapSkillPathsToSandbox(skillPaths, agentDir, sandboxDir),
		sandboxDir,
	};
};

const copyAuthIfPresent = async (authSourcePath: string | null, sandboxHomeDir: string): Promise<void> => {
	if (!authSourcePath) return;
	const targetAuthPath = path.join(sandboxHomeDir, ".pi", "agent", "auth.json");
	await mkdir(path.dirname(targetAuthPath), { recursive: true });
	await copyFile(authSourcePath, targetAuthPath);
	await chmod(targetAuthPath, 0o600);
};

const setupCaseHome = async (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	authSourcePath: string | null;
}): Promise<{ homeDir: string; globalInstructionsPath?: string }> => {
	const { evalCase, workspaceAgentDir, authSourcePath } = params;
	const homeDir = await createSandboxHome(evalCase.id);
	if (evalCase.disableHarness) {
		await copyAuthIfPresent(authSourcePath, homeDir);
		return { homeDir };
	}
	await runEvalSync({
		agentDir: workspaceAgentDir,
		homeDir,
		authSourcePath,
	});
	return { homeDir, globalInstructionsPath: path.join(homeDir, ".pi", "agent", "AGENTS.md") };
};

export const runCase = async (params: {
	evalCase: EvalCase;
	skillMap: Map<string, SkillInfo>;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	thinkingLevel: string;
	authSourcePath: string | null;
	extensionEntry: string;
}): Promise<CaseEvaluation> => {
	const { evalCase, skillMap, model, agentDir, dryRun, thinkingLevel, authSourcePath, extensionEntry } = params;
	const { paths, missing } = resolveSkillPaths(evalCase, skillMap);
	if (missing.length > 0) {
		return buildErrorEvaluation(evalCase, dryRun, `missing skills: ${missing.join(", ")}`);
	}

	let workspace: CaseWorkspace | null = null;
	let homeDir: string | null = null;
	try {
		workspace = await setupCaseWorkspace(evalCase, agentDir, paths);
		const homeSetup = await setupCaseHome({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			authSourcePath,
		});
		homeDir = homeSetup.homeDir;
		const result = await runCaseProcess({
			evalCase,
			skillPaths: workspace.skillPaths,
			model,
			agentDir: workspace.agentDir,
			cwd: workspace.cwd,
			dryRun,
			thinkingLevel,
			tools: resolveTools(evalCase),
			extensionEntry,
			globalInstructionsPath: homeSetup.globalInstructionsPath,
			homeDir,
		});
		result.workspaceDir = workspace.agentDir;
		return evaluateCase(evalCase, result);
	} finally {
		await cleanupSandbox(workspace?.sandboxDir ?? null);
		await cleanupSandboxHome(homeDir);
	}
};
