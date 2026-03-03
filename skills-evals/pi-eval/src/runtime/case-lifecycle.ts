import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
	createSandbox,
	createSandboxHome,
	cleanupSandbox,
	cleanupSandboxHome,
	runEvalSync,
} from "./sandbox.js";
import { buildCaseResult, evaluateCase } from "./scoring.js";
import type { BootstrapBreakdownEntry, BootstrapProfile, CaseEvaluation, EvalCase, ModelSpec } from "../data/types.js";
import { fileExists } from "../data/utils.js";
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
	bootstrapBreakdown: BootstrapBreakdownEntry[];
};

const resolveBootstrapProfile = (evalCase: EvalCase): BootstrapProfile => {
	if (evalCase.bootstrapProfile) return evalCase.bootstrapProfile;
	return evalCase.disableHarness ? "no_payload" : "full_payload";
};

const resolveTools = (evalCase: EvalCase): string[] =>
	evalCase.tools && evalCase.tools.length > 0 ? [...evalCase.tools] : [...DEFAULT_ALLOWED_TOOLS];

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

const NO_PAYLOAD_WORKSPACE_BLOCKLIST = [
	"skills",
	"instructions",
	".agents",
	".codex",
	".pi",
	"AGENTS.md",
];

const NO_PAYLOAD_HOME_BLOCKLIST = [
	path.join(".agents"),
	path.join(".codex"),
	path.join(".codex", "skills"),
	path.join(".pi"),
];

const getNoPayloadDenyRoots = (params: {
	workspaceAgentDir: string;
	homeDir: string;
}): string[] => {
	const workspace = NO_PAYLOAD_WORKSPACE_BLOCKLIST.map((entry) =>
		path.join(params.workspaceAgentDir, entry),
	);
	const home = NO_PAYLOAD_HOME_BLOCKLIST.map((entry) => path.join(params.homeDir, entry));
	return [...workspace, ...home];
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
	buildCategorizedErrorEvaluation(evalCase, dryRun, "TASK_FAILURE", errorMessage);

const buildCategorizedErrorEvaluation = (
	evalCase: EvalCase,
	dryRun: boolean,
	category: "BOOTSTRAP_FAILURE" | "TASK_FAILURE",
	errorMessage: string,
): CaseEvaluation =>
	buildCaseResult(
		evalCase.id,
		buildStubResult(evalCase.id, dryRun, [errorMessage]),
		evalCase,
		[{ category, message: errorMessage }],
	);

const buildBootstrapErrorEvaluation = (
	evalCase: EvalCase,
	dryRun: boolean,
	errorMessage: string,
): CaseEvaluation => buildCategorizedErrorEvaluation(evalCase, dryRun, "BOOTSTRAP_FAILURE", errorMessage);

const resolveExpectedRefCandidates = (
	expectedRef: string,
	workspaceAgentDir: string,
	homeDir: string,
): string[] => {
	if (path.isAbsolute(expectedRef)) return [expectedRef];
	const normalizedRef = expectedRef.replace(/^\.\/+/, "");
	return [
		path.join(workspaceAgentDir, normalizedRef),
		path.join(homeDir, ".agents", normalizedRef),
		path.join(homeDir, ".codex", normalizedRef),
	];
};

const collectMissingExpectedRefs = async (params: {
	expectedRefs: string[];
	workspaceAgentDir: string;
	homeDir: string;
}): Promise<string[]> => {
	const missing: string[] = [];
	for (const expectedRef of params.expectedRefs) {
		const candidates = resolveExpectedRefCandidates(
			expectedRef,
			params.workspaceAgentDir,
			params.homeDir,
		);
		const found = await Promise.all(candidates.map((candidate) => fileExists(candidate)));
		if (!found.some(Boolean)) missing.push(expectedRef);
	}
	return missing;
};

const collectMissingSkillFiles = async (params: {
	expectedSkills: string[];
	workspaceAgentDir: string;
	homeDir: string;
}): Promise<string[]> => {
	const missing: string[] = [];
	for (const expectedSkill of params.expectedSkills) {
		const candidates = [
			path.join(params.workspaceAgentDir, "skills", expectedSkill, "SKILL.md"),
			path.join(params.homeDir, ".agents", "skills", expectedSkill, "SKILL.md"),
			path.join(params.homeDir, ".codex", "skills", expectedSkill, "SKILL.md"),
		];
		const found = await Promise.all(candidates.map((candidate) => fileExists(candidate)));
		if (!found.some(Boolean)) missing.push(expectedSkill);
	}
	return missing;
};

const collectBootstrapPreflightIssues = async (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
}): Promise<string[]> => {
	if (params.bootstrapProfile !== "full_payload") return [];

	const issues: string[] = [];
	const homeAgentsPaths = [
		path.join(params.homeDir, ".agents", "AGENTS.md"),
		path.join(params.homeDir, ".agents", "skills.router.min.json"),
	];
	const homeAgentsChecks = await Promise.all(homeAgentsPaths.map((targetPath) => fileExists(targetPath)));
	if (!homeAgentsChecks[0]) issues.push("missing bootstrap home AGENTS.md");
	if (!homeAgentsChecks[1]) issues.push("missing bootstrap home skills router artifact");

	const workspaceBootstrapPaths = [
		path.join(params.workspaceAgentDir, "AGENTS.md"),
		path.join(params.workspaceAgentDir, "instructions", "skills.router.min.json"),
		path.join(params.workspaceAgentDir, "skills"),
	];
	const workspaceChecks = await Promise.all(
		workspaceBootstrapPaths.map((targetPath) => fileExists(targetPath)),
	);
	if (!workspaceChecks[0]) issues.push("missing workspace AGENTS.md");
	if (!workspaceChecks[1]) issues.push("missing workspace instructions/skills.router.min.json");
	if (!workspaceChecks[2]) issues.push("missing workspace skills directory");

	const [missingSkillFiles, missingExpectedRefs] = await Promise.all([
		collectMissingSkillFiles({
			expectedSkills: params.evalCase.expectedSkills ?? [],
			workspaceAgentDir: params.workspaceAgentDir,
			homeDir: params.homeDir,
		}),
		collectMissingExpectedRefs({
			expectedRefs: params.evalCase.expectedRefs ?? [],
			workspaceAgentDir: params.workspaceAgentDir,
			homeDir: params.homeDir,
		}),
	]);
	if (missingSkillFiles.length > 0) {
		issues.push(`missing sandbox skill files: [${missingSkillFiles.join(", ")}]`);
	}
	if (missingExpectedRefs.length > 0) {
		issues.push(`missing sandbox refs: [${missingExpectedRefs.join(", ")}]`);
	}
	return issues;
};

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
	await Promise.all(
		cleanupTargets.map((targetPath) => rm(targetPath, { recursive: true, force: true })),
	);
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

const measureDirBytes = async (dirPath: string): Promise<number> => {
	let total = 0;
	const entries = await readdir(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			total += await measureDirBytes(entryPath);
		} else {
			total += (await stat(entryPath)).size;
		}
	}
	return total;
};

export const mirrorBootstrapPayloadToWorkspace = async (params: {
	workspaceAgentDir: string;
	homeDir: string;
}): Promise<BootstrapBreakdownEntry[]> => {
	const projections = [
		{
			source: path.join(params.homeDir, ".agents", "AGENTS.md"),
			target: path.join(params.workspaceAgentDir, "AGENTS.md"),
		},
		{
			source: path.join(params.homeDir, ".agents", "skills.router.min.json"),
			target: path.join(params.workspaceAgentDir, "instructions", "skills.router.min.json"),
		},
		{
			source: path.join(params.homeDir, ".agents", "skills"),
			target: path.join(params.workspaceAgentDir, "skills"),
		},
	];

	const breakdown: BootstrapBreakdownEntry[] = [];
	for (const projection of projections) {
		if (!(await fileExists(projection.source))) continue;
		const sourceStat = await stat(projection.source);
		const bytes = sourceStat.isDirectory()
			? await measureDirBytes(projection.source)
			: sourceStat.size;
		breakdown.push({
			path: projection.target,
			bytes,
			estTokens: Math.ceil(bytes / 4),
		});
		await mkdir(path.dirname(projection.target), { recursive: true });
		await cp(projection.source, projection.target, { recursive: true, force: true });
	}
	return breakdown;
};

const setupCaseHome = async (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	hostAgentDir: string;
	authSourcePath: string | null;
}): Promise<HomeSetup> => {
	const { evalCase, workspaceAgentDir, hostAgentDir, authSourcePath } = params;
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
			bootstrapBreakdown: [],
		};
	}

	await runEvalSync({
		sourceAgentDir: hostAgentDir,
		homeDir,
		authSourcePath,
	});
	const bootstrapBreakdown = await mirrorBootstrapPayloadToWorkspace({
		workspaceAgentDir,
		homeDir,
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
		bootstrapBreakdown,
	};
};

export const buildProfileReadDenyPaths = (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
}): string[] => {
	const { evalCase, workspaceAgentDir, homeDir, bootstrapProfile } = params;
	const merged = mergeReadDenyPaths(evalCase.readDenyPaths);
	if (bootstrapProfile !== "no_payload") return merged;

	return mergeReadDenyPaths([
		...merged,
		...getNoPayloadDenyRoots({
			workspaceAgentDir,
			homeDir,
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
			probeErrors.push(`policy deny missing: ${absoluteProbePath}`);
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
