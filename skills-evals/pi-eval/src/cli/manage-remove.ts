/**
 * Resolve and execute removal of an eval case and its artifacts.
 *
 * Consolidates the slug/trace-name derivations that were duplicated
 * between manage.sh and the TS data/reporting modules.
 */
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { slugFromId } from "../data/cases.js";
import { hasPathPrefix } from "../runtime/policy/path-policy.js";
import { traceFileName } from "../reporting/report-persistence.js";

// ── Types ───────────────────────────────────────────────────────────────

export type RemoveTargets = {
	filesToDelete: string[];
	dirsToDelete: string[];
	isBundle: boolean;
	variantTags: string[];
	suite: string;
	/** Args for purge-report.ts CLI (--case, --reports-dir, optionally --variants). */
	purgeArgs: string[];
};

export type RemoveDirs = {
	casesDir: string;
	reportsDir: string;
	generatedDir: string;
};

// ── Target resolution ───────────────────────────────────────────────────

const parseJsonlMetadata = async (jsonlPath: string): Promise<{
	isBundle: boolean;
	suite: string;
	variantTags: string[];
}> => {
	const raw = await readFile(jsonlPath, "utf-8");
	const data = JSON.parse(raw);
	const variants: Array<{ tag?: string }> = Array.isArray(data.variants) ? data.variants : [];
	const tags = variants.map((v) => v.tag ?? "").filter(Boolean);
	return {
		isBundle: tags.length > 0,
		suite: typeof data.suite === "string" ? data.suite : "",
		variantTags: tags,
	};
};

const discoverTraceDirs = async (reportsDir: string): Promise<string[]> => {
	const tracesRoot = path.join(reportsDir, "routing-traces");
	try {
		const entries = await readdir(tracesRoot, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory())
			.map((e) => path.join(tracesRoot, e.name, ""));
	} catch {
		return [];
	}
};

/**
 * Build the list of files/dirs that would be deleted for a given case ID.
 * Uses the canonical `slugFromId` and `traceFileName` from the TS data layer
 * instead of reimplementing them in shell.
 */
export const resolveRemoveTargets = async (
	caseId: string,
	dirs: RemoveDirs,
): Promise<RemoveTargets> => {
	const jsonlPath = path.join(dirs.casesDir, `${caseId}.jsonl`);
	const { isBundle, suite, variantTags } = await parseJsonlMetadata(jsonlPath);
	const slug = slugFromId(caseId);

	const filesToDelete: string[] = [];
	const dirsToDelete: string[] = [];

	// 1. JSONL definition
	filesToDelete.push(jsonlPath);

	// 2. Routing traces
	const modelDirs = await discoverTraceDirs(dirs.reportsDir);
	if (isBundle) {
		for (const modelDir of modelDirs) {
			for (const tag of variantTags) {
				filesToDelete.push(path.join(modelDir, `${traceFileName(`${caseId}:${tag}`)}.json`));
			}
			filesToDelete.push(path.join(modelDir, `${traceFileName(caseId)}--verdict.json`));
		}
	} else {
		for (const modelDir of modelDirs) {
			filesToDelete.push(path.join(modelDir, `${traceFileName(caseId)}.json`));
		}
	}

	// 3. Generated artifacts (bundle only — rm force handles non-existent)
	if (isBundle && suite && slug) {
		dirsToDelete.push(path.join(dirs.generatedDir, suite, slug));
	}

	// 4. Purge args
	const purgeArgs = ["--case", caseId, "--reports-dir", dirs.reportsDir];
	if (isBundle) purgeArgs.push("--variants", variantTags.join(","));

	return { filesToDelete, dirsToDelete, isBundle, variantTags, suite, purgeArgs };
};

// ── Execution ───────────────────────────────────────────────────────────

/**
 * Delete the resolved targets. Each path is validated against allowed roots
 * before deletion.
 */
export const executeRemove = async (
	targets: RemoveTargets,
	dirs: RemoveDirs,
): Promise<string[]> => {
	const deleted: string[] = [];
	const allowedFileRoots = [dirs.casesDir, dirs.reportsDir];
	const allowedDirRoots = [dirs.generatedDir];

	for (const f of targets.filesToDelete) {
		const resolved = path.resolve(f);
		if (!allowedFileRoots.some((root) => hasPathPrefix(resolved, path.resolve(root)))) {
			throw new Error(`delete target outside managed dirs: ${resolved}`);
		}
		await rm(resolved, { force: true });
		deleted.push(resolved);
	}

	for (const d of targets.dirsToDelete) {
		const resolved = path.resolve(d);
		if (!allowedDirRoots.some((root) => hasPathPrefix(resolved, path.resolve(root)))) {
			throw new Error(`delete target outside managed dirs: ${resolved}`);
		}
		await rm(resolved, { recursive: true, force: true });
		deleted.push(resolved);
	}

	return deleted;
};
