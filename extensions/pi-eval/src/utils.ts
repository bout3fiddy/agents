import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const normalizePath = (value: string): string => value.replace(/\\/g, "/");

export const expandHome = (value: string): string => {
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

export const unique = <T>(items: Iterable<T>): T[] => Array.from(new Set(items));

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
