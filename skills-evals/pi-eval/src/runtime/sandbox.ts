import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileExists, normalizePath } from "../data/utils.js";

const SANDBOX_EXCLUDES = [
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
	"coverage",
	".cache",
	"AGENTS.md",
	"skills-evals/reports",
	"skills-evals/logs",
	"docs/specs/pi-eval/reports",
	"docs/specs/pi-eval/logs",
];

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

const shouldCopyToSandbox = (sourcePath: string, baseDir: string): boolean => {
	const relative = normalizePath(path.relative(baseDir, sourcePath));
	if (!relative || relative === ".") return true;
	return !SANDBOX_EXCLUDES.some(
		(entry) => relative === entry || relative.startsWith(`${entry}/`),
	);
};

export const createSandbox = async (agentDir: string, caseId: string): Promise<string> => {
	const sandboxDir = path.join(tmpdir(), "pi-eval-sandbox", caseId, randomUUID());
	await mkdir(sandboxDir, { recursive: true });
	await cp(agentDir, sandboxDir, {
		recursive: true,
		force: true,
		filter: (source) => shouldCopyToSandbox(source, agentDir),
	});
	return sandboxDir;
};

const normalizeMutablePath = (value: string): string => {
	const cleaned = normalizePath(value.trim());
	return cleaned
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/g, "");
};

const buildMutableRoots = (paths: string[]): string[] => {
	const set = new Set<string>();
	for (const value of paths) {
		const normalized = normalizeMutablePath(value);
		if (!normalized) continue;
		set.add(normalized);
	}
	return Array.from(set);
};

const createSymlinkOrFallbackCopy = async (
	sourcePath: string,
	targetPath: string,
	isDirectory: boolean,
) => {
	try {
		await symlink(sourcePath, targetPath, isDirectory ? "dir" : "file");
		return;
	} catch {
		await cp(sourcePath, targetPath, { recursive: true, force: true });
	}
};

export const createSharedCaseWorkspace = async (
	sharedAgentDir: string,
	caseId: string,
	mutablePaths: string[],
): Promise<string> => {
	const sandboxDir = path.join(
		tmpdir(),
		"pi-eval-sandbox",
		`${caseId}-shared`,
		randomUUID(),
	);
	await mkdir(sandboxDir, { recursive: true });

	const mutableRoots = buildMutableRoots(mutablePaths);
	const isMutableAncestor = (entryName: string): boolean =>
		mutableRoots.some((root) => root === entryName || root.startsWith(`${entryName}/`));

	const entries = await readdir(sharedAgentDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sharedAgentDir, entry.name);
		const targetPath = path.join(sandboxDir, entry.name);
		if (isMutableAncestor(entry.name)) {
			await cp(sourcePath, targetPath, { recursive: true, force: true });
			continue;
		}
		await createSymlinkOrFallbackCopy(sourcePath, targetPath, entry.isDirectory());
	}

	for (const value of mutableRoots) {
		const sourcePath = path.join(sharedAgentDir, value);
		const targetPath = path.join(sandboxDir, value);
		if (!(await fileExists(sourcePath))) {
			continue;
		}
		const parent = path.dirname(targetPath);
		await mkdir(parent, { recursive: true });
		await cp(sourcePath, targetPath, { recursive: true, force: true });
	}

	return sandboxDir;
};

export const cleanupSandbox = async (sandboxDir: string | null): Promise<void> => {
	if (!sandboxDir) return;
	await rm(sandboxDir, { recursive: true, force: true });
};

export const createSandboxHome = async (caseId: string): Promise<string> => {
	const homeDir = path.join(tmpdir(), "pi-eval-home", caseId, randomUUID());
	await mkdir(homeDir, { recursive: true });
	return homeDir;
};

export const cleanupSandboxHome = async (homeDir: string | null): Promise<void> => {
	if (!homeDir) return;
	await rm(homeDir, { recursive: true, force: true });
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
	agentDir: string;
	homeDir: string;
	authSourcePath?: string | null;
}): Promise<void> => {
	const { agentDir, homeDir, authSourcePath } = params;
	const syncScript = path.join(agentDir, "bin", "sync.sh");
	if (!(await fileExists(syncScript))) {
		throw new Error(`Sync script not found: ${syncScript}`);
	}

	await acquireSyncSlot();
	try {
		const env = {
			...process.env,
			HOME: homeDir,
			AGENTS_DIR: agentDir,
		};

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const proc = spawn("bash", [syncScript], {
			cwd: agentDir,
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
			`sync ${path.basename(agentDir)}`,
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
	}
};

export const mapSkillPathsToSandbox = (
	paths: string[],
	agentDir: string,
	sandboxDir: string,
): string[] => paths.map((skillPath) => path.join(sandboxDir, path.relative(agentDir, skillPath)));
