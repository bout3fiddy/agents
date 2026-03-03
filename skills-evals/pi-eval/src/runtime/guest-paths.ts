/**
 * Guest path constants and host↔guest path mapping helpers.
 *
 * Extracted from case-process.ts to keep the orchestrator focused on
 * process lifecycle.
 */
import path from "node:path";
import { isPathInsideRoot } from "../data/utils.js";

export const GUEST_WORKSPACE_DIR = "/workspace";
export const GUEST_HOME_DIR = "/home/sandbox";
export const GUEST_OUTPUT_DIR = "/tmp/pi-eval-out";

export const normalizePosixRelative = (relativePath: string): string =>
	relativePath.split(path.sep).join("/");

export const hostPathToGuest = (
	hostPath: string,
	hostRoot: string,
	guestRoot: string,
): string => {
	const absoluteHostPath = path.resolve(hostPath);
	const absoluteHostRoot = path.resolve(hostRoot);
	if (!isPathInsideRoot(absoluteHostPath, absoluteHostRoot)) {
		throw new Error(
			`path '${absoluteHostPath}' is outside sandbox workspace '${absoluteHostRoot}'`,
		);
	}
	const relative = normalizePosixRelative(path.relative(absoluteHostRoot, absoluteHostPath));
	if (!relative || relative === ".") return guestRoot;
	return `${guestRoot}/${relative}`;
};

export const mapReadDenyPathsToGuest = (params: {
	readDenyPaths: string[];
	sandboxWorkspaceDir: string;
	sandboxHomeDir?: string;
}): string[] => {
	const { readDenyPaths, sandboxWorkspaceDir, sandboxHomeDir } = params;
	const guestPaths = new Set<string>();
	for (const denyPath of readDenyPaths) {
		const resolved = path.isAbsolute(denyPath)
			? path.resolve(denyPath)
			: path.resolve(sandboxWorkspaceDir, denyPath);
		if (isPathInsideRoot(resolved, sandboxWorkspaceDir)) {
			guestPaths.add(hostPathToGuest(resolved, sandboxWorkspaceDir, GUEST_WORKSPACE_DIR));
			continue;
		}
		if (sandboxHomeDir && isPathInsideRoot(resolved, sandboxHomeDir)) {
			guestPaths.add(hostPathToGuest(resolved, sandboxHomeDir, GUEST_HOME_DIR));
			continue;
		}
		throw new Error(
			`read deny path '${denyPath}' resolves outside sandbox workspace/home: ${resolved}`,
		);
	}
	return Array.from(guestPaths);
};
