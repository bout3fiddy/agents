import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	createSandbox,
	createSandboxHome,
	cleanupSandbox,
	cleanupSandboxHome,
	runEvalSync,
} from "./sandbox.js";
import { buildCaseResult, evaluateCase } from "./scoring.js";
import type { BootstrapProfile, CaseEvaluation, EvalCase, ModelSpec } from "../data/types.js";
import { DEFAULT_ALLOWED_TOOLS, mergeReadDenyPaths } from "./worker-contract.js";
import { buildStubResult, runCaseProcess } from "./case-process.js";

type CaseWorkspace = {
	agentDir: string;
	cwd: string;
	sandboxDir: string;
};

type HomeSetup = {
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string;
	globalInstructionsPath?: string;
};

const resolveBootstrapProfile = (evalCase: EvalCase): BootstrapProfile => {
	if (evalCase.bootstrapProfile) return evalCase.bootstrapProfile;
	return evalCase.disableHarness ? "no_payload" : "full_payload";
};

const resolveTools = (evalCase: EvalCase): string[] =>
	evalCase.tools && evalCase.tools.length > 0 ? [...evalCase.tools] : [...DEFAULT_ALLOWED_TOOLS];

const buildManifestHash = (params: {
	caseId: string;
	profile: BootstrapProfile;
	availableSkills: string[];
}): string => {
	const payload = JSON.stringify({
		caseId: params.caseId,
		profile: params.profile,
		availableSkills: params.availableSkills,
	});
	return createHash("sha256").update(payload).digest("hex");
};

const listSyncedSkills = async (homeDir: string): Promise<string[]> => {
	const skillsRoot = path.join(homeDir, ".agents", "skills");
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const names = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter(Boolean)
		.sort();
	return names;
};

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

const setupCaseWorkspace = async (evalCase: EvalCase, agentDir: string): Promise<CaseWorkspace> => {
	if (evalCase.sandbox === false) {
		throw new Error(`sandbox:false is forbidden for ${evalCase.id}; isolated sandbox is required`);
	}
	const sandboxDir = await createSandbox(agentDir, evalCase.id);
	return {
		agentDir: sandboxDir,
		cwd: sandboxDir,
		sandboxDir,
	};
};

const hardenNoPayloadWorkspace = async (workspaceAgentDir: string): Promise<void> => {
	await Promise.all([
		rm(path.join(workspaceAgentDir, "skills"), { recursive: true, force: true }),
		rm(path.join(workspaceAgentDir, "instructions"), { recursive: true, force: true }),
	]);
};

const copyAuthIfPresent = async (authSourcePath: string | null, sandboxHomeDir: string): Promise<void> => {
	if (!authSourcePath) return;
	const targetAuthPaths = [
		path.join(sandboxHomeDir, ".pi", "agent", "auth.json"),
		path.join(sandboxHomeDir, ".agents", "auth.json"),
	];
	for (const targetAuthPath of targetAuthPaths) {
		await mkdir(path.dirname(targetAuthPath), { recursive: true });
		await copyFile(authSourcePath, targetAuthPath);
		await chmod(targetAuthPath, 0o600);
	}
};

const setupCaseHome = async (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	authSourcePath: string | null;
}): Promise<HomeSetup> => {
	const { evalCase, workspaceAgentDir, authSourcePath } = params;
	const bootstrapProfile = resolveBootstrapProfile(evalCase);
	const homeDir = await createSandboxHome(evalCase.id);
	await copyAuthIfPresent(authSourcePath, homeDir);

	if (bootstrapProfile === "no_payload") {
		return {
			homeDir,
			bootstrapProfile,
			availableSkills: [],
				bootstrapManifestHash: buildManifestHash({
					caseId: evalCase.id,
					profile: bootstrapProfile,
					availableSkills: [],
				}),
			};
	}

	await runEvalSync({
		agentDir: workspaceAgentDir,
		homeDir,
		authSourcePath,
	});
	const availableSkills = await listSyncedSkills(homeDir);
	return {
		homeDir,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash: buildManifestHash({
			caseId: evalCase.id,
			profile: bootstrapProfile,
			availableSkills,
		}),
		globalInstructionsPath: path.join(homeDir, ".agents", "AGENTS.md"),
	};
};

const buildProfileReadDenyPaths = (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
}): string[] => {
	const { evalCase, workspaceAgentDir, homeDir, bootstrapProfile } = params;
	const merged = mergeReadDenyPaths(evalCase.readDenyPaths);
	if (bootstrapProfile !== "no_payload") return merged;

	const hostHome = homedir();
	return mergeReadDenyPaths([
		...merged,
		path.join(workspaceAgentDir, "skills"),
		path.join(workspaceAgentDir, "instructions"),
		path.join(homeDir, ".agents"),
		path.join(homeDir, ".codex"),
		path.join(hostHome, ".agents"),
		path.join(hostHome, ".codex", "skills"),
	]);
};

const validateCaseSkillExpectations = (evalCase: EvalCase, availableSkills: string[]): string[] => {
	const expected = evalCase.skillSet ?? [];
	if (expected.length === 0) return [];
	return expected.filter((name) => !availableSkills.includes(name));
};

export const runCase = async (params: {
	evalCase: EvalCase;
	model: ModelSpec;
	agentDir: string;
	dryRun: boolean;
	thinkingLevel: string;
	authSourcePath: string | null;
	extensionEntry: string;
}): Promise<CaseEvaluation> => {
	const { evalCase, model, agentDir, dryRun, thinkingLevel, authSourcePath, extensionEntry } = params;
	const bootstrapProfile = resolveBootstrapProfile(evalCase);

	let workspace: CaseWorkspace | null = null;
	let homeDir: string | null = null;
	try {
		workspace = await setupCaseWorkspace(evalCase, agentDir);
		if (bootstrapProfile === "no_payload") {
			await hardenNoPayloadWorkspace(workspace.agentDir);
		}
		const homeSetup = await setupCaseHome({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			authSourcePath,
		});
		homeDir = homeSetup.homeDir;

		const missingSkills = validateCaseSkillExpectations(evalCase, homeSetup.availableSkills);
		if (missingSkills.length > 0) {
			return buildErrorEvaluation(
				evalCase,
				dryRun,
				`missing bootstrap skills: ${missingSkills.join(", ")}`,
			);
		}

		const result = await runCaseProcess({
			evalCase,
			model,
			agentDir: workspace.agentDir,
			cwd: workspace.cwd,
			dryRun,
			thinkingLevel,
			tools: resolveTools(evalCase),
			extensionEntry,
			bootstrapProfile: homeSetup.bootstrapProfile,
			availableSkills: homeSetup.availableSkills,
			bootstrapManifestHash: homeSetup.bootstrapManifestHash,
			readDenyPaths: buildProfileReadDenyPaths({
				evalCase,
				workspaceAgentDir: workspace.agentDir,
				homeDir: homeSetup.homeDir,
				bootstrapProfile: homeSetup.bootstrapProfile,
			}),
			globalInstructionsPath: homeSetup.globalInstructionsPath,
			homeDir: homeSetup.homeDir,
		});
		result.workspaceDir = workspace.agentDir;
		return evaluateCase(evalCase, result);
	} finally {
		await cleanupSandbox(workspace?.sandboxDir ?? null);
		await cleanupSandboxHome(homeDir);
	}
};
