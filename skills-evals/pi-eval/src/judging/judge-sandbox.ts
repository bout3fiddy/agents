import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyAuthIfPresent } from "../runtime/case/bootstrap.js";
import { assertManagedTempPath } from "../runtime/policy/path-policy.js";

const JUDGE_ROOT = path.join(tmpdir(), "pi-eval-judge");

export type JudgeSandboxLayout = {
	workspaceDir: string;
	homeDir: string;
	outputDir: string;
};

export const createJudgeSandbox = async (params: {
	judgeAgentsPath: string;
	authSourcePath: string | null;
}): Promise<JudgeSandboxLayout> => {
	const { judgeAgentsPath, authSourcePath } = params;
	const instanceId = randomUUID();
	const root = path.join(JUDGE_ROOT, "judge", instanceId);
	const workspaceDir = path.join(root, "workspace");
	const homeDir = path.join(root, "home");
	const outputDir = path.join(root, "output");

	await mkdir(workspaceDir, { recursive: true });
	await mkdir(homeDir, { recursive: true });
	await mkdir(outputDir, { recursive: true });

	// Copy judge AGENTS.md and CLAUDE.md into workspace
	await copyFile(judgeAgentsPath, path.join(workspaceDir, "AGENTS.md"));
	const claudeMdContent = "@AGENTS.md\n";
	await writeFile(path.join(workspaceDir, "CLAUDE.md"), claudeMdContent, "utf-8");

	// Copy auth credentials into sandbox home
	await copyAuthIfPresent(authSourcePath, homeDir);

	return { workspaceDir, homeDir, outputDir };
};

export const cleanupJudgeSandbox = async (layout: JudgeSandboxLayout | null): Promise<void> => {
	if (!layout) return;
	// Assert against the managed root — workspaceDir parent's parent is the instance root
	const instanceRoot = path.dirname(layout.workspaceDir);
	const safePath = assertManagedTempPath(instanceRoot, JUDGE_ROOT, "judge sandbox cleanup");
	await rm(safePath, { recursive: true, force: true });
};
