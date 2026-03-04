/**
 * Case-level read deny policy and no-payload workspace hardening.
 *
 * Extracted from case-lifecycle.ts to isolate policy configuration from
 * the case execution orchestrator.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import type { BootstrapProfile, EvalCase } from "../../data/types.js";
import { errorMessage as formatError } from "../../data/utils.js";
import { FORBIDDEN_READ_ERROR, assertReadablePath, createPathDenyPolicy } from "./read-policy.js";
import { POLICY_DENY_ASSERTION_PREFIX } from "../scoring/scoring.js";
import { mergeReadDenyPaths } from "../worker/worker-contract.js";

// ── Blocklists ──────────────────────────────────────────────────────────

export const NO_PAYLOAD_WORKSPACE_BLOCKLIST = [
	"skills",
	"instructions",
	".agents",
	".codex",
	".pi",
	"AGENTS.md",
];

export const NO_PAYLOAD_HOME_BLOCKLIST = [
	path.join(".agents"),
	path.join(".codex"),
	path.join(".codex", "skills"),
	path.join(".pi"),
];

// ── Deny root computation ───────────────────────────────────────────────

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

// ── Workspace hardening ─────────────────────────────────────────────────

export const hardenNoPayloadWorkspace = async (workspaceAgentDir: string): Promise<void> => {
	const cleanupTargets = NO_PAYLOAD_WORKSPACE_BLOCKLIST.map((entry) =>
		path.join(workspaceAgentDir, entry),
	);
	await Promise.all(
		cleanupTargets.map((targetPath) => rm(targetPath, { recursive: true, force: true })),
	);
};

// ── Policy deny probe validation ────────────────────────────────────────

export const extractPolicyProbePaths = (assertions: string[]): string[] =>
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
			const message = formatError(error);
			if (message === FORBIDDEN_READ_ERROR) {
				probeErrors.push(`forbidden read: ${absoluteProbePath}`);
				continue;
			}
			probeErrors.push(`policy deny probe error: ${absoluteProbePath}: ${message}`);
		}
	}
	return probeErrors;
};
