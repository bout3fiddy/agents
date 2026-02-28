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
import { FORBIDDEN_READ_ERROR, assertReadablePath, createPathDenyPolicy } from "./read-policy.js";

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

const NO_PAYLOAD_WORKSPACE_BLOCKLIST = [
	"skills",
	"instructions",
	".agents",
	".codex",
	".pi",
];

const NO_PAYLOAD_HOME_BLOCKLIST = [
	path.join(".agents"),
	path.join(".codex"),
	path.join(".codex", "skills"),
	path.join(".pi"),
];

const NO_PAYLOAD_HOST_HOME_BLOCKLIST = [
	path.join(".agents"),
	path.join(".codex"),
	path.join(".codex", "skills"),
	path.join(".pi"),
];

const getNoPayloadDenyRoots = (params: {
	workspaceAgentDir: string;
	homeDir: string;
	hostHomeDir: string;
	hostWorkspaceDir: string;
}): string[] => {
	const workspace = NO_PAYLOAD_WORKSPACE_BLOCKLIST.map((entry) =>
		path.join(params.workspaceAgentDir, entry),
	);
	const hostWorkspace = NO_PAYLOAD_WORKSPACE_BLOCKLIST.map((entry) =>
		path.join(params.hostWorkspaceDir, entry),
	);
	const home = NO_PAYLOAD_HOME_BLOCKLIST.map((entry) => path.join(params.homeDir, entry));
	const hostHome = NO_PAYLOAD_HOST_HOME_BLOCKLIST.map((entry) => path.join(params.hostHomeDir, entry));
	return [...workspace, ...hostWorkspace, ...home, ...hostHome];
};

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

export const hardenNoPayloadWorkspace = async (workspaceAgentDir: string): Promise<void> => {
	const cleanupTargets = NO_PAYLOAD_WORKSPACE_BLOCKLIST.map((entry) =>
		path.join(workspaceAgentDir, entry),
	);
	await Promise.all([
		...cleanupTargets.map((targetPath) => rm(targetPath, { recursive: true, force: true })),
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

export const buildProfileReadDenyPaths = (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
	hostWorkspaceDir?: string;
}): string[] => {
	const { evalCase, workspaceAgentDir, homeDir, bootstrapProfile, hostWorkspaceDir } = params;
	const merged = mergeReadDenyPaths(evalCase.readDenyPaths);
	if (bootstrapProfile !== "no_payload") return merged;

	const hostHome = homedir();
	const hostWorkspace = hostWorkspaceDir ?? process.cwd();
	return mergeReadDenyPaths([
		...merged,
		...getNoPayloadDenyRoots({
			workspaceAgentDir,
			homeDir,
			hostHomeDir: hostHome,
			hostWorkspaceDir: hostWorkspace,
		}),
	]);
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
		const sourcePath = path.join(params.sandboxAgentDir, artifactPath);
		const targetPath = path.join(params.hostAgentDir, artifactPath);
		try {
			await mkdir(path.dirname(targetPath), { recursive: true });
			await copyFile(sourcePath, targetPath);
		} catch {
			// ignore artifact persistence failures to avoid affecting case scoring
		}
	}
};

const POLICY_DENY_ASSERTION_PREFIX = "must_trigger_policy_deny:";

const extractPolicyProbePaths = (assertions: string[]): string[] =>
	assertions
		.filter((assertion) => assertion.startsWith(POLICY_DENY_ASSERTION_PREFIX))
		.map((assertion) => assertion.slice(POLICY_DENY_ASSERTION_PREFIX.length).trim())
		.filter((probePath) => probePath.length > 0);

export const collectPolicyDenyProbeErrors = async (params: {
	cwd: string;
	readDenyPaths: string[];
	assertions: string[];
}): Promise<string[]> => {
	const probePaths = extractPolicyProbePaths(params.assertions);
	if (probePaths.length === 0) return [];
	const denyPolicy = await createPathDenyPolicy(params.cwd, params.readDenyPaths);
	const probeErrors: string[] = [];
	for (const probePath of probePaths) {
		const absoluteProbePath = path.resolve(params.cwd, probePath);
		try {
			await assertReadablePath(absoluteProbePath, denyPolicy);
			probeErrors.push(`policy deny probe not denied: ${absoluteProbePath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === FORBIDDEN_READ_ERROR) {
				probeErrors.push(`forbidden read: ${absoluteProbePath}`);
				continue;
			}
			probeErrors.push(`policy deny probe error: ${absoluteProbePath}: ${message}`);
		}
	}
	return probeErrors;
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

		const profileReadDenyPaths = buildProfileReadDenyPaths({
			evalCase,
			workspaceAgentDir: workspace.agentDir,
			homeDir: homeSetup.homeDir,
			bootstrapProfile: homeSetup.bootstrapProfile,
		});

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
			readDenyPaths: profileReadDenyPaths,
			globalInstructionsPath: homeSetup.globalInstructionsPath,
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
		return evaluateCase(evalCase, result, {
			expectedBootstrapManifestHash: homeSetup.bootstrapManifestHash,
		});
	} finally {
		await cleanupSandbox(workspace?.sandboxDir ?? null);
		await cleanupSandboxHome(homeDir);
	}
};
