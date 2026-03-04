/**
 * Unified path policy module.
 *
 * Consolidates path predicates (hasPathPrefix, isPathInsideRoot, resolveInsideRoot,
 * normalizePath) from data/utils.ts and path segment sanitization / managed-temp
 * guards from the former path-safety.ts into a single module.
 *
 * Also provides a shared resolveCanonicalPath that unifies the divergent
 * symlink-resolution strategies (parent-walk in sandbox-boundary.ts vs
 * simple fsRealpath+cache in read-policy.ts).
 */
import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

// ── Path predicates (moved from data/utils.ts) ─────────────────────────

export const hasPathPrefix = (candidate: string, root: string): boolean =>
	candidate === root ||
	candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

export const isPathInsideRoot = (targetPath: string, rootPath: string): boolean => {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const resolveInsideRoot = (rootPath: string, relativePath: string): string => {
	const resolved = path.resolve(rootPath, relativePath);
	if (!isPathInsideRoot(resolved, rootPath)) {
		throw new Error(`path escapes root: ${relativePath} (root=${rootPath})`);
	}
	return resolved;
};

export const normalizePath = (value: string): string => value.replace(/\\/g, "/");

// ── Segment sanitization (moved from path-safety.ts) ────────────────────

const PATH_SEGMENT_SAFE_CHARS = /[^a-zA-Z0-9._-]+/g;
const DUPLICATE_SEPARATORS = /[-._]{2,}/g;

export const toSafePathSegment = (value: string, fallback = "case"): string => {
	const trimmed = value.trim();
	const sanitized = trimmed
		.replace(PATH_SEGMENT_SAFE_CHARS, "-")
		.replace(DUPLICATE_SEPARATORS, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
	return sanitized.length > 0 ? sanitized : fallback;
};

// ── Managed temp path assertion (moved from path-safety.ts) ─────────────

export const assertManagedTempPath = (
	targetPath: string,
	rootPath: string,
	label: string,
): string => {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	if (!isPathInsideRoot(resolvedTarget, resolvedRoot)) {
		throw new Error(
			`${label} path is outside managed cleanup root: ${resolvedTarget} (root=${resolvedRoot})`,
		);
	}

	const relative = path.relative(resolvedRoot, resolvedTarget);
	const segments = relative.split(path.sep).filter(Boolean);
	if (segments.length < 2) {
		throw new Error(
			`${label} path is too shallow for recursive cleanup: ${resolvedTarget} (root=${resolvedRoot})`,
		);
	}
	return resolvedTarget;
};

// ── Canonical path resolution ───────────────────────────────────────────

/**
 * Resolve the canonical (symlink-resolved) form of `absolutePath`.
 *
 * Strategy:
 * 1. Try `fs.realpath` on the full path.
 * 2. If it doesn't exist, walk up to the nearest existing parent and
 *    re-append the trailing segments (parent-walk strategy from
 *    sandbox-boundary.ts).
 * 3. Results are cached when a `cache` map is provided (as in
 *    read-policy.ts).
 *
 * Returns `null` only when no ancestor exists on disk.
 */
export const resolveCanonicalPath = async (
	absolutePath: string,
	cache?: Map<string, string | null>,
): Promise<string | null> => {
	if (cache) {
		const cached = cache.get(absolutePath);
		if (cached !== undefined) return cached;
	}

	// Fast path: full path exists
	try {
		const real = await fsRealpath(absolutePath);
		cache?.set(absolutePath, real);
		return real;
	} catch {
		// fall through to parent walk
	}

	// Parent walk: resolve the nearest existing ancestor
	let current = absolutePath;
	const trailingSegments: string[] = [];
	while (true) {
		const parent = path.dirname(current);
		if (parent === current) {
			// Reached filesystem root without resolving
			cache?.set(absolutePath, null);
			return null;
		}
		trailingSegments.unshift(path.basename(current));
		current = parent;
		try {
			const real = await fsRealpath(current);
			const result = path.join(real, ...trailingSegments);
			cache?.set(absolutePath, result);
			return result;
		} catch {
			// continue walking up
		}
	}
};
