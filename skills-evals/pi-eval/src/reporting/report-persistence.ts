import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReport, readReportRows, updateIndex, writeReport } from "./report.js";
import type { CaseEvaluation, EvalCase, EvalRunOptions, ModelSpec } from "../data/types.js";
import { ensureDir } from "../data/utils.js";

const reportPathFor = (reportRoot: string, model: ModelSpec): string => {
	const safeModel = `${model.provider}-${model.id}`.replace(/[^a-zA-Z0-9-_]+/g, "-");
	return path.join(reportRoot, `${safeModel}.md`);
};

const indexPathFor = (reportRoot: string): string => path.join(reportRoot, "index.json");

const getCommitSha = async (): Promise<string> => {
	try {
		const { execSync } = await import("node:child_process");
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withReportWriteLock = async <T>(lockPath: string, handler: () => Promise<T>): Promise<T> => {
	await ensureDir(path.dirname(lockPath));
	const startedAt = Date.now();
	const timeoutMs = 90_000;

	while (true) {
		try {
			await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
			break;
		} catch (error) {
			const maybeErrno = error as NodeJS.ErrnoException;
			if (maybeErrno?.code !== "EEXIST") throw error;
			if (Date.now() - startedAt > timeoutMs) {
				throw new Error(`Timed out waiting for report write lock: ${lockPath}`);
			}
			await sleep(200);
		}
	}

	try {
		return await handler();
	} finally {
		await unlink(lockPath).catch(() => undefined);
	}
};

export const persistRunReport = async (params: {
	options: EvalRunOptions;
	defaultCases: EvalCase[];
	evaluations: CaseEvaluation[];
	durationMs: number;
}): Promise<{ reportPath: string; indexPath: string }> => {
	const { options, defaultCases, evaluations, durationMs } = params;
	const commitSha = await getCommitSha();
	const reportRoot = path.join(options.agentDir, "skills-evals", "reports");
	const reportPath = reportPathFor(reportRoot, options.model);
	const indexPath = indexPathFor(reportRoot);
	const reportLockPath = path.join(reportRoot, ".report-write.lock");
	const runTimestamp = new Date().toISOString();

	await withReportWriteLock(reportLockPath, async () => {
		const previousRows = await readReportRows(reportPath);
		const reportContent = buildReport({
			model: options.model,
			commitSha,
			runTimestamp,
			evaluations,
			durationMs,
			allCases: defaultCases,
			previousRows,
			runScope: options.isFullRun ? "full" : "partial",
			filter: options.filter,
			limit: options.limitOverride,
			casesPathLabel: options.casesPathLabel,
		});
		await writeReport(reportPath, reportContent);
		if (options.isFullRun) {
			await updateIndex(indexPath, options.model.key, { sha: commitSha, timestamp: runTimestamp });
		}
	});

	return { reportPath, indexPath };
};
