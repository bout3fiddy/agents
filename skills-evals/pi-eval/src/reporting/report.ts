import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaseEvaluation, EvalCase, JudgeVerdict, ModelSpec } from "../data/types.js";
import { ensureDir, fileExists, formatDuration, median, percentile } from "../data/utils.js";

type ReportRow = {
	caseId: string;
	mode: string;
	status: string;
	tokens: number;
	turns: number;
	skillsRead: number;
	skillFilesRead: number;
	refsRead: number;
	missingRefs: string;
	unexpectedRefs: string;
	notes: string;
	run: string;
};

const buildRowKey = (caseId: string, mode: string): string => `${caseId}::${mode}`;

const normalizeStatus = (value: string): string => value.trim().toUpperCase();

const runDateFromTimestamp = (timestamp: string): string => timestamp.split("T")[0] ?? timestamp;
const joinRoutingList = (values: string[] | undefined): string => {
	if (!values || values.length === 0) return "-";
	return values.join(", ");
};

const formatTokenStats = (tokens: number[]) => {
	return {
		max: Math.max(0, ...tokens),
		median: median(tokens),
		p95: percentile(tokens, 95),
	};
};

const UNPAIRED_TABLE_SENTINEL = "<!-- UNPAIRED_TABLE_START -->";

const parseReportRows = (content: string): Map<string, ReportRow> => {
	const rows = new Map<string, ReportRow>();
	const lines = content.split("\n");
	const sentinelIndex = lines.findIndex((line) => line.trim() === UNPAIRED_TABLE_SENTINEL);
	const searchStart = sentinelIndex >= 0 ? sentinelIndex : 0;
	const headerIndex = lines.findIndex((line, idx) => idx >= searchStart && line.trimStart().startsWith("| Case "));
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
	const turnsIdx = columnIndex("Turns");
	const skillsReadIdx = columnIndex("Skills Read");
	const skillFilesReadIdx = columnIndex("Skill Files Read");
	const refsReadIdx = columnIndex("Refs Read");
	const missingRefsIdx = columnIndex("Missing Refs");
	const unexpectedRefsIdx = columnIndex("Unexpected Refs");
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
		const turnsValue = Number.parseInt(turnsIdx >= 0 ? (cells[turnsIdx] ?? "0") : "0", 10);
		const turns = Number.isFinite(turnsValue) ? turnsValue : 0;
		const skillsReadValue = Number.parseInt(skillsReadIdx >= 0 ? (cells[skillsReadIdx] ?? "0") : "0", 10);
		const skillsRead = Number.isFinite(skillsReadValue) ? skillsReadValue : 0;
		const skillFilesReadValue = Number.parseInt(
			skillFilesReadIdx >= 0 ? (cells[skillFilesReadIdx] ?? "0") : "0",
			10,
		);
		const skillFilesRead = Number.isFinite(skillFilesReadValue) ? skillFilesReadValue : 0;
		const refsReadValue = Number.parseInt(refsReadIdx >= 0 ? (cells[refsReadIdx] ?? "0") : "0", 10);
		const refsRead = Number.isFinite(refsReadValue) ? refsReadValue : 0;
		const missingRefs = missingRefsIdx >= 0 ? (cells[missingRefsIdx] ?? "-") : "-";
		const unexpectedRefs = unexpectedRefsIdx >= 0 ? (cells[unexpectedRefsIdx] ?? "-") : "-";
		const status = cells[statusIdx] ?? "";
		const notes = cells[notesIdx] ?? "";
		const run = runIdx >= 0 ? cells[runIdx] ?? "-" : "-";
		rows.set(buildRowKey(caseId, mode), {
			caseId,
			mode,
			status,
			tokens,
			turns,
			skillsRead,
			skillFilesRead,
			refsRead,
			missingRefs,
			unexpectedRefs,
			notes,
			run,
		});
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
			turns: evaluation.result.turnBreakdown?.length ?? 0,
			skillsRead: evaluation.routing.readSkills.length,
			skillFilesRead: evaluation.routing.readSkillFiles.length,
			refsRead: evaluation.routing.readRefs.length,
			missingRefs: joinRoutingList(evaluation.routing.missingRefs),
			unexpectedRefs: joinRoutingList(evaluation.routing.unexpectedRefs),
			notes: evaluation.reasons.join("; "),
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
					turns: 0,
					skillsRead: 0,
					skillFilesRead: 0,
					refsRead: 0,
					missingRefs: "-",
					unexpectedRefs: "-",
					notes: "not run",
					run: "-",
				} satisfies ReportRow);
			rows.push(row);
		}
	}

	return rows;
};

type PairedSection = {
	baseId: string;
	controlId: string;
	skillRow: ReportRow;
	controlRow: ReportRow;
	verdict: JudgeVerdict;
};

const renderPairedVariantTable = (skillRow: ReportRow, controlRow: ReportRow): string => {
	const header = "| Variant | Status | Tokens | Turns | Skills Read | Refs Read |";
	const separator = "| --- | --- | --- | --- | --- | --- |";
	const skillLine = `| ${skillRow.caseId} (skill) | ${normalizeStatus(skillRow.status)} | ${skillRow.tokens} | ${skillRow.turns} | ${skillRow.skillsRead} | ${skillRow.refsRead} |`;
	const controlLine = `| ${controlRow.caseId} (control) | ${normalizeStatus(controlRow.status)} | ${controlRow.tokens} | ${controlRow.turns} | ${controlRow.skillsRead} | ${controlRow.refsRead} |`;
	return [header, separator, skillLine, controlLine].join("\n");
};

const renderDimensionsTable = (verdict: JudgeVerdict): string => {
	const header = "| Dimension | Skill | Control | Rationale |";
	const separator = "| --- | --- | --- | --- |";
	const rows = verdict.dimensions.map(
		(d) => `| ${d.name} | ${d.skillScore} | ${d.controlScore} | ${d.rationale} |`,
	);
	return [header, separator, ...rows].join("\n");
};

const renderPairedSections = (sections: PairedSection[]): string => {
	if (sections.length === 0) return "";
	const parts: string[] = ["## Paired Evaluations", ""];
	for (const section of sections) {
		parts.push(`### ${section.baseId}: ${section.skillRow.notes || "paired comparison"}`);
		parts.push(renderPairedVariantTable(section.skillRow, section.controlRow));
		parts.push("");
		parts.push(`**Judge Verdict** (token cost: ${section.verdict.judgeTokens.totalTokens})`);
		parts.push("");
		parts.push(renderDimensionsTable(section.verdict));
		parts.push("");
		if (section.verdict.costAnalysis) {
			parts.push(`> **Cost Analysis**: ${section.verdict.costAnalysis}`);
			parts.push("");
		}
		if (section.verdict.recommendation) {
			parts.push(`> **Recommendation**: ${section.verdict.recommendation}`);
			parts.push("");
		}
		parts.push("---");
		parts.push("");
	}
	return parts.join("\n");
};

const renderCaseTable = (rows: ReportRow[]): string => {
	const outputRows = rows.map((row) => {
		const status = normalizeStatus(row.status) || "";
		const tokenCount = row.tokens || 0;
		const turnCount = row.turns || 0;
		return `| ${row.caseId} | ${row.mode} | ${status} | ${tokenCount} | ${turnCount} | ${row.skillsRead} | ${row.skillFilesRead} | ${row.refsRead} | ${row.missingRefs} | ${row.unexpectedRefs} | ${row.notes} | ${row.run} |`;
	});
	return [
		"| Case | Mode | Status | Tokens | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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

const collectPairedSections = (
	evaluations: CaseEvaluation[],
	allRows: ReportRow[],
): { sections: PairedSection[]; pairedCaseIds: Set<string> } => {
	const pairedCaseIds = new Set<string>();
	const sections: PairedSection[] = [];

	for (const evaluation of evaluations) {
		if (!evaluation.judgeVerdict) continue;
		const verdict = evaluation.judgeVerdict;
		const baseId = verdict.pairId;
		const controlId = verdict.controlId;
		const skillRow = allRows.find((r) => r.caseId === baseId);
		const controlRow = allRows.find((r) => r.caseId === controlId);
		if (!skillRow || !controlRow) continue;
		sections.push({ baseId, controlId, skillRow, controlRow, verdict });
		pairedCaseIds.add(baseId);
		pairedCaseIds.add(controlId);
	}
	return { sections, pairedCaseIds };
};

export const buildReport = (params: {
	model: ModelSpec;
	commitSha: string;
	runTimestamp: string;
	evaluations: CaseEvaluation[];
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
	const { sections, pairedCaseIds } = collectPairedSections(evaluations, rows);
	const unpairedRows = rows.filter((row) => !pairedCaseIds.has(row.caseId));
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

	const reportParts = [...headerLines, ""];
	if (sections.length > 0) {
		reportParts.push(renderPairedSections(sections));
	}
	reportParts.push("## Case Results");
	reportParts.push(UNPAIRED_TABLE_SENTINEL);
	reportParts.push(renderCaseTable(unpairedRows));
	reportParts.push("");
	reportParts.push("## Failures");
	reportParts.push(renderFailures(rows));
	reportParts.push("");

	return reportParts.join("\n");
};

const writeTextFile = async (filePath: string, content: string): Promise<void> => {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, content);
};

export const writeReport = writeTextFile;

export const updateIndex = async (indexPath: string, modelKey: string, payload: { sha: string; timestamp: string }) => {
	const indexData: Record<string, { sha: string; timestamp: string }> = {};
	try {
		const raw = await readFile(indexPath, "utf-8");
		Object.assign(indexData, JSON.parse(raw));
	} catch {
		// ignore missing index
	}
	indexData[modelKey] = payload;
	await writeTextFile(indexPath, JSON.stringify(indexData, null, 2));
};
