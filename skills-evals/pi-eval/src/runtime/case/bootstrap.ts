/**
 * Bootstrap lifecycle for eval case home directories.
 *
 * Handles profile resolution, home setup, auth copying, skill discovery,
 * workspace mirroring, and preflight validation.
 */
import { chmod, copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
	BootstrapBreakdownEntry,
	BootstrapProfile,
	CaseEvaluation,
	EvalCase,
} from "../../data/types.js";
import { fileExists } from "../../data/utils.js";
import { buildStubResult } from "./case-process.js";
import {
	createSandboxHome,
	runEvalSync,
} from "../sandbox/sandbox.js";
import { buildCaseResult, buildManifestHash } from "../scoring/scoring.js";
import { DEFAULT_ALLOWED_TOOLS } from "../worker/worker-contract.js";

// ── Types ───────────────────────────────────────────────────────────────

export type HomeSetup = {
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string;
	bootstrapBreakdown: BootstrapBreakdownEntry[];
};

// ── Profile / tool resolution ───────────────────────────────────────────

export const resolveBootstrapProfile = (evalCase: EvalCase): BootstrapProfile => {
	if (evalCase.bootstrapProfile) return evalCase.bootstrapProfile;
	return evalCase.disableHarness ? "no_payload" : "full_payload";
};

export const resolveTools = (evalCase: EvalCase): string[] =>
	evalCase.tools && evalCase.tools.length > 0 ? [...evalCase.tools] : [...DEFAULT_ALLOWED_TOOLS];

// ── Auth copying ────────────────────────────────────────────────────────

export const copyAuthIfPresent = async (authSourcePath: string | null, sandboxHomeDir: string): Promise<void> => {
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

// ── Skill / ref discovery ───────────────────────────────────────────────

export const listSyncedSkills = async (homeDir: string): Promise<string[]> => {
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

export const resolveExpectedRefCandidates = (
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

export const collectMissingExpectedRefs = async (params: {
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

export const collectMissingSkillFiles = async (params: {
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

// ── Workspace mirroring ─────────────────────────────────────────────────

export const measureDirBytes = async (dirPath: string): Promise<number> => {
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
			source: path.join(params.homeDir, ".agents", "skills"),
			target: path.join(params.workspaceAgentDir, "skills"),
		},
		{
			source: path.join(params.homeDir, ".agents", "workflows"),
			target: path.join(params.workspaceAgentDir, "workflows"),
		},
	];

	const breakdown: BootstrapBreakdownEntry[] = [];
	for (const projection of projections) {
		let sourceStat: Awaited<ReturnType<typeof stat>>;
		try {
			sourceStat = await stat(projection.source);
		} catch {
			continue;
		}
		const bytes = sourceStat.isDirectory()
			? await measureDirBytes(projection.source)
			: sourceStat.size;
		breakdown.push({
			path: projection.target,
			bytes,
		});
		await mkdir(path.dirname(projection.target), { recursive: true });
		await cp(projection.source, projection.target, { recursive: true, force: true });
	}
	return breakdown;
};

// ── Preflight checks ────────────────────────────────────────────────────

export const collectBootstrapPreflightIssues = async (params: {
	evalCase: EvalCase;
	workspaceAgentDir: string;
	homeDir: string;
	bootstrapProfile: BootstrapProfile;
}): Promise<string[]> => {
	if (params.bootstrapProfile !== "full_payload") return [];

	const issues: string[] = [];
	const homeAgentsPaths = [
		path.join(params.homeDir, ".agents", "AGENTS.md"),
	];
	const homeAgentsChecks = await Promise.all(homeAgentsPaths.map((targetPath) => fileExists(targetPath)));
	if (!homeAgentsChecks[0]) issues.push("missing bootstrap home AGENTS.md");

	const workspaceBootstrapPaths = [
		path.join(params.workspaceAgentDir, "AGENTS.md"),
		path.join(params.workspaceAgentDir, "skills"),
	];
	const workspaceChecks = await Promise.all(
		workspaceBootstrapPaths.map((targetPath) => fileExists(targetPath)),
	);
	if (!workspaceChecks[0]) issues.push("missing workspace AGENTS.md");
	if (!workspaceChecks[1]) issues.push("missing workspace skills directory");

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

// ── Error evaluation builders ───────────────────────────────────────────

export const buildBootstrapErrorEvaluation = (
	evalCase: EvalCase,
	dryRun: boolean,
	errorMessage: string,
): CaseEvaluation =>
	buildCaseResult(
		evalCase.id,
		buildStubResult(evalCase.id, dryRun, [errorMessage]),
		evalCase,
		[{ category: "BOOTSTRAP_FAILURE", message: errorMessage }],
	);

// ── Home setup orchestrator ─────────────────────────────────────────────

export const setupCaseHome = async (params: {
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
