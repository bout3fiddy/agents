import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileExists } from "../data/utils.js";
import { assertManagedTempPath, toSafePathSegment } from "./path-safety.js";

const WORKSPACE_INCLUDE_PATHS = [
	path.join("skills-evals", "fixtures"),
	path.join("skills-evals", "pi-eval", "index.ts"),
	path.join("skills-evals", "pi-eval", "worker.ts"),
	path.join("skills-evals", "pi-eval", "src"),
	path.join("skills-evals", "pi-eval", "config"),
];
const SYNC_SOURCE_INCLUDE_PATHS = [
	path.join("bin", "sync.sh"),
	"skills",
	"instructions",
	path.join("skills-evals", "validate"),
];

const SANDBOX_ROOT = path.join(tmpdir(), "pi-eval-sandbox");
const HOME_ROOT = path.join(tmpdir(), "pi-eval-home");
const SYNC_SOURCE_ROOT = path.join(tmpdir(), "pi-eval-sync-source");

let activeSyncCount = 0;
const syncWaitQueue: Array<() => void> = [];

const parsePositiveIntEnv = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? `${fallback}`, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return parsed;
};

const getSyncParallelismLimit = (): number =>
	parsePositiveIntEnv(process.env.PI_EVAL_SYNC_PARALLELISM, 4);

const acquireSyncSlot = async (): Promise<void> => {
	const limit = getSyncParallelismLimit();
	if (activeSyncCount < limit) {
		activeSyncCount += 1;
		return;
	}

	await new Promise<void>((resolve) => {
		syncWaitQueue.push(() => {
			activeSyncCount += 1;
			resolve();
		});
	});
};

const releaseSyncSlot = (): void => {
	activeSyncCount = Math.max(0, activeSyncCount - 1);
	const next = syncWaitQueue.shift();
	next?.();
};

const copyWorkspaceEntry = async (params: {
	agentDir: string;
	sandboxDir: string;
	relativePath: string;
}): Promise<void> => {
	const sourcePath = path.join(params.agentDir, params.relativePath);
	if (!(await fileExists(sourcePath))) return;
	const targetPath = path.join(params.sandboxDir, params.relativePath);
	await mkdir(path.dirname(targetPath), { recursive: true });
	await cp(sourcePath, targetPath, { recursive: true, force: true });
};

const createSyncSource = async (sourceAgentDir: string): Promise<string> => {
	const syncSourceDir = path.join(SYNC_SOURCE_ROOT, randomUUID());
	await mkdir(syncSourceDir, { recursive: true });
	for (const relativePath of SYNC_SOURCE_INCLUDE_PATHS) {
		const sourcePath = path.join(sourceAgentDir, relativePath);
		if (!(await fileExists(sourcePath))) continue;
		const targetPath = path.join(syncSourceDir, relativePath);
		await mkdir(path.dirname(targetPath), { recursive: true });
		await cp(sourcePath, targetPath, { recursive: true, force: true });
	}
	return syncSourceDir;
};

export const createSandbox = async (agentDir: string, caseId: string): Promise<string> => {
	const safeCaseId = toSafePathSegment(caseId, "case");
	const sandboxDir = path.join(SANDBOX_ROOT, safeCaseId, randomUUID());
	await mkdir(sandboxDir, { recursive: true });
	for (const relativePath of WORKSPACE_INCLUDE_PATHS) {
		await copyWorkspaceEntry({ agentDir, sandboxDir, relativePath });
	}
	await mkdir(path.join(sandboxDir, "skills-evals", "generated"), { recursive: true });
	return sandboxDir;
};

export const cleanupSandbox = async (sandboxDir: string | null): Promise<void> => {
	if (!sandboxDir) return;
	const safePath = assertManagedTempPath(sandboxDir, SANDBOX_ROOT, "sandbox cleanup");
	await rm(safePath, { recursive: true, force: true });
};

export const createSandboxHome = async (caseId: string): Promise<string> => {
	const safeCaseId = toSafePathSegment(caseId, "case");
	const homeDir = path.join(HOME_ROOT, safeCaseId, randomUUID());
	await mkdir(homeDir, { recursive: true });
	return homeDir;
};

export const cleanupSandboxHome = async (homeDir: string | null): Promise<void> => {
	if (!homeDir) return;
	const safePath = assertManagedTempPath(homeDir, HOME_ROOT, "home cleanup");
	await rm(safePath, { recursive: true, force: true });
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
	let timeoutId: NodeJS.Timeout;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	const result = await Promise.race([promise, timeoutPromise]);
	clearTimeout(timeoutId!);
	return result;
};

export const runEvalSync = async (params: {
	sourceAgentDir: string;
	homeDir: string;
	authSourcePath?: string | null;
}): Promise<void> => {
	const { sourceAgentDir, homeDir, authSourcePath } = params;
	const syncSourceDir = await createSyncSource(sourceAgentDir);
	const syncScript = path.join(syncSourceDir, "bin", "sync.sh");

	await acquireSyncSlot();
	try {
		if (!(await fileExists(syncScript))) {
			throw new Error(`Sync script not found: ${syncScript}`);
		}
		const env = {
			...process.env,
			HOME: homeDir,
			AGENTS_DIR: syncSourceDir,
		};

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const proc = spawn("bash", [syncScript], {
			cwd: syncSourceDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
		proc.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

		const exitCode = await withTimeout(
			new Promise<number>((resolve, reject) => {
				proc.on("close", (code) => resolve(code ?? 0));
				proc.on("error", (error) => reject(error));
			}),
			30_000,
			`sync ${path.basename(syncSourceDir)}`,
		);

		if (exitCode !== 0) {
			const stdout = stdoutChunks.join("").trim();
			const stderr = stderrChunks.join("").trim();
			const detail = [stderr, stdout].filter(Boolean).join(" | ");
			throw new Error(`sync failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`);
		}

		if (authSourcePath) {
			const targetAuthPaths = [
				path.join(homeDir, ".pi", "agent", "auth.json"),
				path.join(homeDir, ".agents", "auth.json"),
			];
			for (const targetAuthPath of targetAuthPaths) {
				await mkdir(path.dirname(targetAuthPath), { recursive: true });
				await copyFile(authSourcePath, targetAuthPath);
				try {
					await chmod(targetAuthPath, 0o600);
				} catch {
					// ignore chmod failures
				}
			}
		}
	} finally {
		releaseSyncSlot();
		await rm(syncSourceDir, { recursive: true, force: true });
	}
};
