import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { color } from "./logger.js";
import type { CaseEvaluation, EvalCase, MatrixEvaluation, ModelSpec } from "./types.js";
import { ensureDir, fileExists, formatDuration, median, percentile } from "./utils.js";

type ReportRow = {
	caseId: string;
	mode: string;
	status: string;
	tokens: number;
	notes: string;
	run: string;
};

const buildRowKey = (caseId: string, mode: string): string => `${caseId}::${mode}`;

const normalizeStatus = (value: string): string => value.trim().toUpperCase();

const runDateFromTimestamp = (timestamp: string): string => timestamp.split("T")[0] ?? timestamp;

const formatTokenStats = (tokens: number[]) => {
	return {
		max: Math.max(0, ...tokens),
		median: median(tokens),
		p95: percentile(tokens, 95),
	};
};

const parseReportRows = (content: string): Map<string, ReportRow> => {
	const rows = new Map<string, ReportRow>();
	const lines = content.split("\n");
	const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| Case "));
	if (headerIndex === -1) return rows;
	const headerCells = lines[headerIndex]
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());
	const columnIndex = (name: string): number =>
		headerCells.findIndex((cell) => cell.toLowerCase() === name.toLowerCase());
	const caseIdx = columnIndex("Case");
	const modeIdx = columnIndex("Mode");
	const statusIdx = columnIndex("Status");
	const tokensIdx = columnIndex("Tokens");
	const notesIdx = columnIndex("Notes");
	const runIdx = columnIndex("Run");
	if (caseIdx < 0 || modeIdx < 0) return rows;

	for (let i = headerIndex + 2; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (!line.trim().startsWith("|")) break;
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		const requiredMax = Math.max(caseIdx, modeIdx, statusIdx, tokensIdx, notesIdx, runIdx);
		if (cells.length <= requiredMax) continue;
		const caseId = cells[caseIdx] ?? "";
		const mode = cells[modeIdx] ?? "";
		if (!caseId || !mode) continue;
		const tokensValue = Number.parseInt(cells[tokensIdx] ?? "0", 10);
		const tokens = Number.isFinite(tokensValue) ? tokensValue : 0;
		const status = cells[statusIdx] ?? "";
		const notes = cells[notesIdx] ?? "";
		const run = runIdx >= 0 ? cells[runIdx] ?? "-" : "-";
		rows.set(buildRowKey(caseId, mode), { caseId, mode, status, tokens, notes, run });
	}

	return rows;
};

export const readReportRows = async (filePath: string): Promise<Map<string, ReportRow>> => {
	if (!(await fileExists(filePath))) return new Map();
	const raw = await readFile(filePath, "utf-8");
	return parseReportRows(raw);
};

const mergeReportRows = (params: {
	evaluations: CaseEvaluation[];
	allCases: EvalCase[];
	previousRows: Map<string, ReportRow>;
	runTimestamp: string;
}): ReportRow[] => {
	const { evaluations, allCases, previousRows, runTimestamp } = params;
	const runDate = runDateFromTimestamp(runTimestamp);
	const updatedRows = new Map<string, ReportRow>();
	const updatedModes = new Map<string, Set<string>>();
	const previousModes = new Map<string, Set<string>>();

	for (const row of previousRows.values()) {
		if (!previousModes.has(row.caseId)) {
			previousModes.set(row.caseId, new Set());
		}
		previousModes.get(row.caseId)?.add(row.mode);
	}

	for (const evaluation of evaluations) {
		const key = buildRowKey(evaluation.caseId, evaluation.mode);
		const row: ReportRow = {
			caseId: evaluation.caseId,
			mode: evaluation.mode,
			status: evaluation.status === "pass" ? "PASS" : "FAIL",
			tokens: evaluation.result.tokens.totalTokens || 0,
			notes: evaluation.reasons[0] ?? "",
			run: runDate,
		};
		updatedRows.set(key, row);
		if (!updatedModes.has(row.caseId)) {
			updatedModes.set(row.caseId, new Set());
		}
		updatedModes.get(row.caseId)?.add(row.mode);
	}

	const caseIds = new Set<string>();
	for (const evalCase of allCases) {
		caseIds.add(evalCase.id);
	}
	for (const caseId of previousModes.keys()) {
		caseIds.add(caseId);
	}
	for (const caseId of updatedModes.keys()) {
		caseIds.add(caseId);
	}

	const rows: ReportRow[] = [];
	const modeOrder = new Map(["single", "baseline", "interference"].map((mode, index) => [mode, index]));
	const sortedCaseIds = Array.from(caseIds).sort((a, b) => a.localeCompare(b));

	for (const caseId of sortedCaseIds) {
		const modes = new Set<string>();
		for (const mode of previousModes.get(caseId) ?? []) {
			modes.add(mode);
		}
		for (const mode of updatedModes.get(caseId) ?? []) {
			modes.add(mode);
		}
		if (modes.size === 0) {
			modes.add("single");
		}
		const sortedModes = Array.from(modes).sort((a, b) => {
			const aOrder = modeOrder.get(a) ?? Number.POSITIVE_INFINITY;
			const bOrder = modeOrder.get(b) ?? Number.POSITIVE_INFINITY;
			if (aOrder !== bOrder) return aOrder - bOrder;
			return a.localeCompare(b);
		});
		for (const mode of sortedModes) {
			const key = buildRowKey(caseId, mode);
			const row =
				updatedRows.get(key) ??
				previousRows.get(key) ??
				({
					caseId,
					mode,
					status: "SKIP",
					tokens: 0,
					notes: "not run",
					run: "-",
				} satisfies ReportRow);
			rows.push(row);
		}
	}

	return rows;
};

const renderCaseTable = (rows: ReportRow[]): string => {
	const outputRows = rows.map((row) => {
		const status = normalizeStatus(row.status) || "";
		const tokenCount = row.tokens || 0;
		return `| ${row.caseId} | ${row.mode} | ${status} | ${tokenCount} | ${row.notes} | ${row.run} |`;
	});
	return [
		"| Case | Mode | Status | Tokens | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- |",
		...outputRows,
	].join("\n");
};

const renderFailures = (rows: ReportRow[]): string => {
	const failures = rows.filter((item) => normalizeStatus(item.status) === "FAIL");
	if (failures.length === 0) return "All cases passed.";
	return failures
		.map((item) => `- **${item.caseId}** (${item.mode}): ${item.notes || "failed"}`)
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
	allCases: EvalCase[];
	previousRows: Map<string, ReportRow>;
	runScope: "full" | "partial";
	filter?: string | null;
	limit?: number | null;
	casesPathLabel?: string;
}): string => {
	const {
		model,
		commitSha,
		runTimestamp,
		evaluations,
		matrix,
		durationMs,
		allCases,
		previousRows,
		runScope,
		filter,
		limit,
		casesPathLabel,
	} = params;
	const tokens = evaluations.map((item) => item.result.tokens.totalTokens || 0);
	const stats = formatTokenStats(tokens);
	const rows = mergeReportRows({ evaluations, allCases, previousRows, runTimestamp });
	const rowPass = rows.filter((item) => normalizeStatus(item.status) === "PASS").length;
	const rowFail = rows.filter((item) => normalizeStatus(item.status) === "FAIL").length;
	const rowSkip = rows.filter((item) => normalizeStatus(item.status) === "SKIP").length;
	const executedCases = new Set(evaluations.map((item) => item.caseId)).size;
	const executedRows = evaluations.length;
	const totalCases = new Set(rows.map((row) => row.caseId)).size;
	const totalRows = rows.length;
	const scopeDetails: string[] = [];
	if (filter) scopeDetails.push(`filter=${filter}`);
	if (limit) scopeDetails.push(`limit=${limit}`);
	const scopeLabel = scopeDetails.length > 0 ? `${runScope} (${scopeDetails.join(", ")})` : runScope;

	const headerLines = [
		"NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.",
		"",
		"# Pi Eval Report",
		"",
		`- Model: ${model.label}`,
		`- Commit: ${commitSha}`,
		`- Run: ${runTimestamp}`,
		`- Run scope: ${scopeLabel}`,
		`- Cases executed: ${executedCases} (${executedRows} rows)`,
		`- Case rows: ${totalRows} (pass ${rowPass}, fail ${rowFail}, skip ${rowSkip})`,
		`- Cases in spec: ${totalCases}`,
		`- Duration: ${formatDuration(durationMs)}`,
		`- Token stats (this run): max ${stats.max}, median ${stats.median}, p95 ${stats.p95}`,
	];
	if (casesPathLabel) {
		headerLines.splice(6, 0, `- Cases path: ${casesPathLabel}`);
	}

	return [
		...headerLines,
		"",
		"## Case Results",
		renderCaseTable(rows),
		"",
		renderMatrixNotes(matrix),
		"## Failures",
		renderFailures(rows),
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

export const renderReportNotice = (
	filePath: string,
	indexPath: string,
	options: { indexUpdated?: boolean } = {},
) => {
	console.log(color.success(`Report written: ${filePath}`));
	if (options.indexUpdated) {
		console.log(color.muted(`Index updated: ${indexPath}`));
	} else {
		console.log(color.warning(`Index not updated (partial run): ${indexPath}`));
	}
};
