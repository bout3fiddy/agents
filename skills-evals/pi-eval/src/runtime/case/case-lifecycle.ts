import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
	createSandbox,
	cleanupSandbox,
	cleanupSandboxHome,
} from "../sandbox/sandbox.js";
import {
	evaluateCase,
} from "../scoring/scoring.js";
import { buildCaseResult } from "../scoring/scoring.js";
import type { CaseEvaluation, EvalCase, ModelSpec } from "../../data/types.js";
import { resolveInsideRoot } from "../policy/path-policy.js";
import { buildStubResult, runCaseProcess } from "./case-process.js";
import {
	resolveBootstrapProfile,
	resolveTools,
	setupCaseHome,
	collectBootstrapPreflightIssues,
	buildBootstrapErrorEvaluation,
} from "./bootstrap.js";
import {
	buildProfileReadDenyPaths,
	collectPolicyDenyProbeErrors,
	hardenNoPayloadWorkspace,
} from "../policy/case-policy.js";

type CaseWorkspace = {
	agentDir: string;
	cwd: string;
	sandboxDir: string;
};

export const resolveSandboxExtensionEntry = (params: {
	hostExtensionEntry: string;
	hostAgentDir: string;
	sandboxAgentDir: string;
}): string => {
	const relativePath = path.relative(params.hostAgentDir, params.hostExtensionEntry);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error(
			`extension entry must be inside agent dir: ${params.hostExtensionEntry} (agent dir ${params.hostAgentDir})`,
		);
	}
	return path.join(params.sandboxAgentDir, relativePath);
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
		[{ category: "TASK_FAILURE", message: errorMessage }],
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

const stageFixtures = async (sandboxDir: string, mapping: Record<string, string>): Promise<void> => {
	for (const [neutralPath, realPath] of Object.entries(mapping)) {
		const source = path.join(sandboxDir, realPath);
		const target = path.join(sandboxDir, neutralPath);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
	}
};

const validateCaseSkillExpectations = (evalCase: EvalCase, availableSkills: string[]): string[] => {
	const expected = evalCase.skillSet ?? [];
	if (expected.length === 0) return [];
	return expected.filter((name) => !availableSkills.includes(name));
};

const resolvePersistArtifactPaths = (evalCase: EvalCase): string[] => {
	if (!evalCase.persistArtifacts) return [];
	const paths = (evalCase.fileAssertions ?? [])
		.map((assertion) => assertion.path)
		.filter((artifactPath) => typeof artifactPath === "string" && artifactPath.trim().length > 0);
	return Array.from(new Set(paths));
};

const persistCaseArtifacts = async (params: {
	evalCase: EvalCase;
	hostAgentDir: string;
	sandboxAgentDir: string;
}): Promise<void> => {
	const artifactPaths = resolvePersistArtifactPaths(params.evalCase);
	for (const artifactPath of artifactPaths) {
		try {
			const sourcePath = resolveInsideRoot(params.sandboxAgentDir, artifactPath);
			const targetPath = resolveInsideRoot(params.hostAgentDir, artifactPath);
			await mkdir(path.dirname(targetPath), { recursive: true });
			await copyFile(sourcePath, targetPath);
		} catch {
			// ignore artifact persistence failures to avoid affecting case scoring
		}
	}
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
		if (evalCase.fixtureMapping) {
			await stageFixtures(workspace.sandboxDir, evalCase.fixtureMapping);
		}
		if (bootstrapProfile === "no_payload") {
			await hardenNoPayloadWorkspace(workspace.agentDir);
		}
		const homeSetup = await setupCaseHome({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			hostAgentDir: agentDir,
			authSourcePath,
		});
		homeDir = homeSetup.homeDir;

		const missingSkills = validateCaseSkillExpectations(evalCase, homeSetup.availableSkills);
		if (missingSkills.length > 0) {
			return buildBootstrapErrorEvaluation(
				evalCase,
				dryRun,
				`missing bootstrap skills: ${missingSkills.join(", ")}`,
			);
		}

		const preflightIssues = await collectBootstrapPreflightIssues({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			homeDir: homeSetup.homeDir,
			bootstrapProfile: homeSetup.bootstrapProfile,
		});
		if (preflightIssues.length > 0) {
			return buildBootstrapErrorEvaluation(
				evalCase,
				dryRun,
				`bootstrap preflight failed: ${preflightIssues.join("; ")}`,
			);
		}

		const profileReadDenyPaths = buildProfileReadDenyPaths({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			homeDir: homeSetup.homeDir,
			bootstrapProfile: homeSetup.bootstrapProfile,
		});

		const result = await runCaseProcess({
			evalCase,
			model,
			cwd: workspace.cwd,
			dryRun,
			thinkingLevel,
			tools: resolveTools(evalCase),
			extensionEntry: resolveSandboxExtensionEntry({
				hostExtensionEntry: extensionEntry,
				hostAgentDir: agentDir,
				sandboxAgentDir: workspace.agentDir,
			}),
			bootstrapProfile: homeSetup.bootstrapProfile,
			availableSkills: homeSetup.availableSkills,
			bootstrapManifestHash: homeSetup.bootstrapManifestHash,
			readDenyPaths: profileReadDenyPaths,
			homeDir: homeSetup.homeDir,
		});
		result.errors.push(
			...(await collectPolicyDenyProbeErrors({
				cwd: workspace.cwd,
				readDenyPaths: profileReadDenyPaths,
				assertions: evalCase.assertions ?? [],
			})),
		);
		await persistCaseArtifacts({
			evalCase,
			hostAgentDir: agentDir,
			sandboxAgentDir: workspace.agentDir,
		});
		result.workspaceDir = workspace.agentDir;
		result.bootstrapBreakdown = homeSetup.bootstrapBreakdown;
		return evaluateCase(evalCase, result, {
			expectedBootstrapManifestHash: homeSetup.bootstrapManifestHash,
		});
	} finally {
		await cleanupSandbox(workspace?.sandboxDir ?? null);
		await cleanupSandboxHome(homeDir);
	}
};
