/**
 * Bootstrap lifecycle for eval case home directories.
 *
 * Handles profile resolution, home setup, auth copying, skill discovery,
 * workspace mirroring, and preflight validation.
 */
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { createHash } from "node:crypto";
import { buildCaseResult } from "./evaluation.js";
import { DEFAULT_ALLOWED_TOOLS } from "../worker/worker-contract.js";

// ── Bootstrap manifest hash ─────────────────────────────────────────────

const buildManifestHash = (params: {
	caseId: string;
	profile: string;
	availableSkills: string[];
}): string => {
	const payload = JSON.stringify({
		caseId: params.caseId,
		profile: params.profile,
		availableSkills: [...params.availableSkills].sort(),
	});
	return createHash("sha256").update(payload).digest("hex");
};

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

// ── Skill-set scoping ──────────────────────────────────────────────────

const normalizeSkillSet = (skillSet: string[] | undefined): string[] => {
	const names = new Set<string>();
	for (const rawName of skillSet ?? []) {
		const name = rawName.trim();
		if (!name) continue;
		if (
			path.isAbsolute(name) ||
			name.includes("/") ||
			name.includes("\\") ||
			name === "." ||
			name === ".." ||
			name.startsWith(".")
		) {
			throw new Error(`invalid skillSet entry: ${rawName}`);
		}
		names.add(name);
	}
	return Array.from(names).sort();
};

const parseSkillDescription = (skillFile: string): string => {
	if (!skillFile.startsWith("---")) return "";
	const end = skillFile.indexOf("\n---", 3);
	if (end === -1) return "";
	const frontmatter = skillFile.slice(3, end);
	const line = frontmatter
		.split("\n")
		.find((entry) => entry.trimStart().startsWith("description:"));
	if (!line) return "";
	return line
		.replace(/^\s*description:\s*/, "")
		.trim()
		.replace(/^['"]|['"]$/g, "");
};

const readSkillDescription = async (skillsRoot: string, skillName: string): Promise<string> => {
	try {
		const skillFile = await readFile(path.join(skillsRoot, skillName, "SKILL.md"), "utf-8");
		const description = parseSkillDescription(skillFile);
		if (description) return description;
	} catch {
		// Missing skills are reported by the normal bootstrap skill expectation check.
	}
	return "Read this skill when the task matches its name.";
};

const buildScopedAgentsMarkdown = async (
	skillsRoot: string,
	skillNames: string[],
): Promise<string> => {
	const lines = [
		"# Eval Instructions",
		"",
		"This eval sandbox exposes only the skills listed below.",
		"Before reading or editing task code, read the matching skill file.",
		"Do not use skills outside this list.",
		"",
		"## Available Skills",
		"",
	];
	for (const skillName of skillNames) {
		const description = await readSkillDescription(skillsRoot, skillName);
		lines.push(`- \`${skillName}\`: \`skills/${skillName}/SKILL.md\` - ${description}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
};

const pruneDirectoryToEntries = async (root: string, keepNames: Set<string>): Promise<void> => {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (keepNames.has(entry.name)) continue;
		await rm(path.join(root, entry.name), { recursive: true, force: true });
	}
};

export const applySkillSetBootstrapScope = async (
	homeDir: string,
	skillSet: string[] | undefined,
): Promise<void> => {
	const scopedSkills = normalizeSkillSet(skillSet);
	if (scopedSkills.length === 0) return;

	const keepSkills = new Set(scopedSkills);
	const agentsRoot = path.join(homeDir, ".agents");
	const agentsSkillsRoot = path.join(agentsRoot, "skills");
	await pruneDirectoryToEntries(agentsSkillsRoot, keepSkills);
	await rm(path.join(agentsRoot, "workflows"), { recursive: true, force: true });
	await writeFile(
		path.join(agentsRoot, "AGENTS.md"),
		await buildScopedAgentsMarkdown(agentsSkillsRoot, scopedSkills),
		"utf-8",
	);

	const claudeRoot = path.join(homeDir, ".claude");
	await pruneDirectoryToEntries(path.join(claudeRoot, "skills"), keepSkills);
	await rm(path.join(claudeRoot, "workflows"), { recursive: true, force: true });
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
	await applySkillSetBootstrapScope(homeDir, evalCase.skillSet);
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
