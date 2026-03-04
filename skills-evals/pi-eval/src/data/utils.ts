import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const withTimeout = async <T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> => {
	let timeoutId: NodeJS.Timeout;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		clearTimeout(timeoutId!);
	}
};

export const parsePositiveInt = (
	value: string | undefined,
	fallback: number,
): number => {
	const parsed = Number.parseInt(value ?? `${fallback}`, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return parsed;
};

export const uniqueSorted = (values: string[]): string[] =>
	Array.from(
		new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)),
	).sort((a, b) => a.localeCompare(b));

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const expandHome = (value: string): string => {
	if (!value.startsWith("~")) {
		return value;
	}
	if (value === "~") {
		return homedir();
	}
	return path.join(homedir(), value.slice(2));
};

export const resolvePath = (value: string, baseDir: string): string => {
	const expanded = expandHome(value);
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
};

export const ensureDir = async (dir: string): Promise<void> => {
	await mkdir(dir, { recursive: true });
};

export const readJson = async <T>(filePath: string): Promise<T> => {
	const raw = await readFile(filePath, "utf-8");
	return JSON.parse(raw) as T;
};

export const fileExists = async (filePath: string): Promise<boolean> => {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
};

export const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = Math.round(seconds % 60);
	return `${minutes}m ${remaining}s`;
};

export const median = (values: number[]): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1] + sorted[mid]) / 2;
	}
	return sorted[mid];
};

export const percentile = (values: number[], pct: number): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil((pct / 100) * sorted.length) - 1;
	const safeIndex = Math.min(Math.max(index, 0), sorted.length - 1);
	return sorted[safeIndex];
};
