import { writeFile } from "node:fs/promises";
import path from "node:path";
import { color } from "./logger.js";
import type { CaseEvaluation, MatrixEvaluation, ModelSpec } from "./types.js";
import { ensureDir, formatDuration, median, percentile } from "./utils.js";

const formatTokenStats = (tokens: number[]) => {
	return {
		max: Math.max(0, ...tokens),
		median: median(tokens),
		p95: percentile(tokens, 95),
	};
};

const renderCaseTable = (evaluations: CaseEvaluation[]): string => {
	const rows = evaluations.map((evalResult) => {
		const status = evalResult.status === "pass" ? "PASS" : "FAIL";
		const tokenCount = evalResult.result.tokens.totalTokens || 0;
		const reason = evalResult.reasons[0] ?? "";
		return `| ${evalResult.caseId} | ${evalResult.mode} | ${status} | ${tokenCount} | ${reason} |`;
	});
	return [
		"| Case | Mode | Status | Tokens | Notes |",
		"| --- | --- | --- | --- | --- |",
		...rows,
	].join("\n");
};

const renderFailures = (evaluations: CaseEvaluation[]): string => {
	const failures = evaluations.filter((item) => item.status === "fail");
	if (failures.length === 0) return "All cases passed.";
	return failures
		.map((item) => `- **${item.caseId}** (${item.mode}): ${item.reasons.join("; ")}`)
		.join("\n");
};

const renderMatrixNotes = (matrix: MatrixEvaluation[]): string => {
	if (matrix.length === 0) return "";
	const lines = matrix.map(
		(item) => `- **${item.evalCase.id}**: ${item.deltaSummary}`,
	);
	return ["## Matrix Deltas", ...lines, ""].join("\n");
};

export const buildReport = (params: {
	model: ModelSpec;
	commitSha: string;
	runTimestamp: string;
	evaluations: CaseEvaluation[];
	matrix: MatrixEvaluation[];
	durationMs: number;
}): string => {
	const { model, commitSha, runTimestamp, evaluations, matrix, durationMs } = params;
	const tokens = evaluations.map((item) => item.result.tokens.totalTokens || 0);
	const stats = formatTokenStats(tokens);
	const passed = evaluations.filter((item) => item.status === "pass").length;
	const failed = evaluations.length - passed;

	return [
		`# Pi Eval Report`,
		"",
		`- Model: ${model.label}`,
		`- Commit: ${commitSha}`,
		`- Run: ${runTimestamp}`,
		`- Duration: ${formatDuration(durationMs)}`,
		`- Cases: ${evaluations.length} (pass ${passed}, fail ${failed})`,
		`- Token stats: max ${stats.max}, median ${stats.median}, p95 ${stats.p95}`,
		"",
		"## Case Results",
		renderCaseTable(evaluations),
		"",
		renderMatrixNotes(matrix),
		"## Failures",
		renderFailures(evaluations),
		"",
	].join("\n");
};

export const writeReport = async (filePath: string, content: string): Promise<void> => {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, content);
};

export const updateIndex = async (indexPath: string, modelKey: string, payload: { sha: string; timestamp: string }) => {
	const indexData: Record<string, { sha: string; timestamp: string }> = {};
	try {
		const raw = await (await import("node:fs/promises")).readFile(indexPath, "utf-8");
		Object.assign(indexData, JSON.parse(raw));
	} catch {
		// ignore missing index
	}
	indexData[modelKey] = payload;
	await ensureDir(path.dirname(indexPath));
	await writeFile(indexPath, JSON.stringify(indexData, null, 2));
};

export const renderReportNotice = (filePath: string, indexPath: string) => {
	console.log(color.success(`Report written: ${filePath}`));
	console.log(color.muted(`Index updated: ${indexPath}`));
};
