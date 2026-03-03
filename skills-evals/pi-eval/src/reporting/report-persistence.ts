import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReport, readReportRows, updateIndex, writeReport } from "./report.js";
import type { CaseEvaluation, EvalBundle, EvalRunOptions, JudgeBundleVerdict, ModelSpec, ResolvedEvalCase } from "../data/types.js";
import { ensureDir, sleep } from "../data/utils.js";
import { toSafePathSegment } from "../runtime/path-safety.js";

const modelSafeKey = (model: ModelSpec): string =>
	`${model.provider}-${model.id}`.replace(/[^a-zA-Z0-9-_]+/g, "-");

const reportPathFor = (reportRoot: string, model: ModelSpec): string =>
	path.join(reportRoot, `${modelSafeKey(model)}.md`);

const indexPathFor = (reportRoot: string): string => path.join(reportRoot, "index.json");
const routingTraceDirFor = (reportRoot: string, model: ModelSpec): string =>
	path.join(reportRoot, "routing-traces", modelSafeKey(model));

const getCommitSha = async (): Promise<string> => {
	try {
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }, (error, stdout) => {
				resolve(error ? "unknown" : stdout.trim());
			});
		});
	} catch {
		return "unknown";
	}
};

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

/** Convert case IDs with colons to filesystem-safe names using -- separator */
const traceFileName = (caseId: string): string => {
	// Replace colon separator (bundle:tag) with double-dash for readability
	const safeName = caseId.replace(/:/g, "--");
	return toSafePathSegment(safeName, "case");
};

const writeRoutingTraceArtifacts = async (params: {
	traceDir: string;
	runTimestamp: string;
	model: ModelSpec;
	evaluations: CaseEvaluation[];
}): Promise<void> => {
	const { traceDir, runTimestamp, model, evaluations } = params;
	await ensureDir(traceDir);
	await Promise.all(evaluations.map((evaluation) => {
		const payload = {
			caseId: evaluation.caseId,
			mode: evaluation.mode,
			status: evaluation.status,
			runTimestamp,
			model: model.label,
			expectedSkills: evaluation.expectedSkills,
			expectedRefs: evaluation.expectedRefs,
			tokens: evaluation.result.tokens,
			turnBreakdown: evaluation.result.turnBreakdown ?? [],
			toolUsage: evaluation.result.toolUsage ?? null,
			rpcDiagnostics: evaluation.result.rpcDiagnostics ?? null,
			outputTextPreview: (evaluation.result.outputText ?? "").slice(0, 1200),
			resultErrors: evaluation.result.errors ?? [],
			routing: evaluation.routing,
			reasons: evaluation.reasons,
			failureReasons: evaluation.failureReasons,
			readBreakdown: evaluation.result.readBreakdown ?? [],
			bootstrapBreakdown: evaluation.result.bootstrapBreakdown ?? [],
			judgeVerdict: evaluation.judgeVerdict ?? null,
		};
		const tracePath = path.join(traceDir, `${traceFileName(evaluation.caseId)}.json`);
		return writeFile(tracePath, JSON.stringify(payload, null, 2));
	}));
};

const writeBundleVerdictTraces = async (params: {
	traceDir: string;
	verdicts: Map<string, JudgeBundleVerdict>;
}): Promise<void> => {
	const { traceDir, verdicts } = params;
	if (verdicts.size === 0) return;
	await ensureDir(traceDir);
	await Promise.all([...verdicts.entries()].map(([bundleId, verdict]) => {
		const tracePath = path.join(traceDir, `${traceFileName(bundleId)}--verdict.json`);
		return writeFile(tracePath, JSON.stringify(verdict, null, 2));
	}));
};

export const persistRunReport = async (params: {
	options: EvalRunOptions;
	defaultCases: ResolvedEvalCase[];
	evaluations: CaseEvaluation[];
	bundles: Map<string, EvalBundle>;
	durationMs: number;
}): Promise<{ reportPath: string; indexPath: string }> => {
	const { options, defaultCases, evaluations, bundles, durationMs } = params;
	const commitSha = await getCommitSha();
	const reportRoot = path.join(options.agentDir, "skills-evals", "reports");
	const reportPath = reportPathFor(reportRoot, options.model);
	const indexPath = indexPathFor(reportRoot);
	const routingTraceDir = routingTraceDirFor(reportRoot, options.model);
	const reportLockPath = path.join(reportRoot, ".report-write.lock");
	const runTimestamp = new Date().toISOString();

	// Collect bundle verdicts from evaluations
	const verdicts = new Map<string, JudgeBundleVerdict>();
	for (const evaluation of evaluations) {
		if (evaluation.judgeVerdict && !verdicts.has(evaluation.judgeVerdict.bundleId)) {
			verdicts.set(evaluation.judgeVerdict.bundleId, evaluation.judgeVerdict);
		}
	}

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
			bundles,
			filter: options.filter,
			limit: options.limitOverride,
			casesPathLabel: options.casesPathLabel,
		});
		await writeReport(reportPath, reportContent);
		if (options.isFullRun) {
			await updateIndex(indexPath, options.model.key, { sha: commitSha, timestamp: runTimestamp });
		}
		await writeRoutingTraceArtifacts({
			traceDir: routingTraceDir,
			runTimestamp,
			model: options.model,
			evaluations,
		});
		await writeBundleVerdictTraces({
			traceDir: routingTraceDir,
			verdicts,
		});
	});

	return { reportPath, indexPath };
};
