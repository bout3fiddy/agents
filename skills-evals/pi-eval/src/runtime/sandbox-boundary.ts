import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../data/utils.js";

export const FORBIDDEN_WORKSPACE_VIOLATION = "FORBIDDEN_WORKSPACE_VIOLATION";

export type ToolWithExecute = {
	execute: (toolCallId: string, args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
};

export type SandboxBoundary = {
	cwd: string;
	sandboxRoot: string;
	sandboxRootCanonical: string | null;
	violations: Set<string>;
};

const hasPathPrefix = (candidate: string, root: string): boolean =>
	candidate === root ||
	candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

export const createSandboxBoundary = async (
	cwd: string,
	sandboxRootPath: string,
): Promise<SandboxBoundary> => {
	const sandboxRoot = path.resolve(sandboxRootPath);
	const sandboxRootCanonical = await fsRealpath(sandboxRoot).catch(() => null);
	return {
		cwd,
		sandboxRoot,
		sandboxRootCanonical,
		violations: new Set<string>(),
	};
};

const registerSandboxViolation = (boundary: SandboxBoundary, targetPath: string): never => {
	const normalized = normalizePath(targetPath);
	boundary.violations.add(normalized);
	throw new Error(`${FORBIDDEN_WORKSPACE_VIOLATION}: Attempted to access path outside sandbox: ${targetPath}`);
};

export const assertWithinSandboxBoundary = async (
	rawPath: string,
	boundary: SandboxBoundary,
): Promise<void> => {
	const resolvedPath = path.resolve(boundary.cwd, rawPath);
	if (!hasPathPrefix(resolvedPath, boundary.sandboxRoot)) {
		registerSandboxViolation(boundary, resolvedPath);
	}
	if (!boundary.sandboxRootCanonical) return;
	const canonicalPath = await fsRealpath(resolvedPath).catch(() => null);
	if (canonicalPath && !hasPathPrefix(canonicalPath, boundary.sandboxRootCanonical)) {
		registerSandboxViolation(boundary, canonicalPath);
	}
};

const PATH_KEY_PATTERN = /(path|file|dir|cwd|target)/i;

export const extractPathCandidates = (value: unknown, keyHint = "", depth = 0): string[] => {
	if (depth > 4) return [];
	if (typeof value === "string") {
		return PATH_KEY_PATTERN.test(keyHint) ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => extractPathCandidates(item, keyHint, depth + 1));
	}
	if (!value || typeof value !== "object") return [];
	const objectValue = value as Record<string, unknown>;
	return Object.entries(objectValue).flatMap(([key, child]) =>
		extractPathCandidates(child, key, depth + 1)
	);
};

export const wrapToolWithSandboxBoundary = <T extends ToolWithExecute>(
	tool: T,
	boundary: SandboxBoundary,
): T => ({
	...tool,
	execute: async (toolCallId: string, args: Record<string, unknown>) => {
		for (const targetPath of extractPathCandidates(args)) {
			await assertWithinSandboxBoundary(targetPath, boundary);
		}
		return tool.execute(toolCallId, args, undefined);
	},
});
