import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";
import { hasPathPrefix, normalizePath } from "../data/utils.js";

export const FORBIDDEN_READ_ERROR = "ENOENT: no such file or directory";

export type PathDenyPolicy = {
	logicalRoots: string[];
	canonicalRoots: string[];
	deniedReads: Set<string>;
	canonicalCache: Map<string, string | null>;
};

export const createPathDenyPolicy = async (
	cwd: string,
	readDenyPaths: string[],
): Promise<PathDenyPolicy> => {
	const logicalRoots = readDenyPaths.map((entry) => path.resolve(cwd, entry));
	const canonicalRoots: string[] = [];
	for (const root of logicalRoots) {
		const canonical = await fsRealpath(root).catch(() => null);
		if (canonical) canonicalRoots.push(canonical);
	}
	return {
		logicalRoots,
		canonicalRoots,
		deniedReads: new Set<string>(),
		canonicalCache: new Map<string, string | null>(),
	};
};

const resolveCanonical = async (
	absolutePath: string,
	cache: Map<string, string | null>,
): Promise<string | null> => {
	const cached = cache.get(absolutePath);
	if (cached !== undefined) return cached;
	try {
		const canonical = await fsRealpath(absolutePath);
		cache.set(absolutePath, canonical);
		return canonical;
	} catch {
		cache.set(absolutePath, null);
		return null;
	}
};

export const assertReadablePath = async (
	absolutePath: string,
	policy: PathDenyPolicy,
): Promise<void> => {
	const logical = path.resolve(absolutePath);
	for (const root of policy.logicalRoots) {
		if (hasPathPrefix(logical, root)) {
			policy.deniedReads.add(normalizePath(logical));
			throw new Error(FORBIDDEN_READ_ERROR);
		}
	}
	const canonical = await resolveCanonical(logical, policy.canonicalCache);
	if (!canonical) return;
	for (const root of policy.canonicalRoots) {
		if (hasPathPrefix(canonical, root)) {
			policy.deniedReads.add(normalizePath(canonical));
			throw new Error(FORBIDDEN_READ_ERROR);
		}
	}
};
