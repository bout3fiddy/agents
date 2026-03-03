import path from "node:path";
import { isPathInsideRoot } from "../data/utils.js";

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
