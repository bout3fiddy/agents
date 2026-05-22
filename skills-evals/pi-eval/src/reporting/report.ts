import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiCostFromTokens, type CaseEvaluation, type JudgeSuiteVerdict, type ModelSpec, type ResolvedEvalCase } from "../data/types.js";
import { ensureDir, fileExists, formatDuration, median, percentile } from "../data/utils.js";
import {
	JUDGE_REPORT_END,
	JUDGE_REPORT_START,
	UNPAIRED_TABLE_SENTINEL,
	buildRowKey,
	normalizeStatus,
	parseStandaloneTable,
	type ReportRow,
} from "./report-document.js";

const runDateFromTimestamp = (timestamp: string): string => timestamp.split("T")[0] ?? timestamp;
const joinRoutingList = (values: string[] | undefined): string => {
	if (!values || values.length === 0) return "-";
	return values.join(", ");
};

const formatCostStats = (costs: number[]) => ({
	max: Math.max(0, ...costs),
	median: median(costs),
	p95: percentile(costs, 95),
});

const variantTagFor = (evalCase: ResolvedEvalCase | undefined): string =>
	evalCase?.variantTag ?? "single";

const findVariantVerdict = (evaluation: CaseEvaluation, evalCase: ResolvedEvalCase | undefined) => {
	const tag = variantTagFor(evalCase);
	return evaluation.judgeVerdict?.variants.find((variant) => variant.tag === tag) ?? null;
};

const taskStatusFor = (
	evaluation: CaseEvaluation,
	evalCase: ResolvedEvalCase | undefined,
): "pass" | "fail" => {
	const variantVerdict = findVariantVerdict(evaluation, evalCase);
	if (evaluation.status === "fail") return "fail";
	if (variantVerdict && !variantVerdict.taskPass) return "fail";
	return "pass";
};

const judgeLabelFor = (
	evaluation: CaseEvaluation,
	evalCase: ResolvedEvalCase | undefined,
): string => {
	const caseVerdict = evaluation.judgeVerdict;
	if (!caseVerdict) return "-";
	const variantVerdict = findVariantVerdict(evaluation, evalCase);
	if (!variantVerdict) return "JUDGE MISSING";
	if (!evalCase?.bundleId) return variantVerdict.taskPass ? "STANDALONE OK" : "STANDALONE FAIL";
	const tag = variantTagFor(evalCase);
	if (tag === "skill") {
		if (caseVerdict.skillBenefit === "clear") return "SKILL WIN";
		if (caseVerdict.skillBenefit === "none") return "NO CLEAR WIN";
		if (caseVerdict.skillBenefit === "worse") return "SKILL WORSE";
		return "INCONCLUSIVE";
	}
	if (tag === "noskill") return variantVerdict.taskPass ? "BASELINE OK" : "BASELINE FAIL";
	return variantVerdict.taskPass ? "TASK OK" : "TASK FAIL";
};

const taskNotesFor = (
	evaluation: CaseEvaluation,
	evalCase: ResolvedEvalCase | undefined,
): string => {
	const notes = [...evaluation.reasons];
	const variantVerdict = findVariantVerdict(evaluation, evalCase);
	if (evaluation.status === "pass" && variantVerdict && !variantVerdict.taskPass) {
		notes.push(`JUDGE_TASK: ${variantVerdict.rationale}`);
	}
	return notes.join("; ");
};

const formatComparisonStats = (judgeVerdict: JudgeSuiteVerdict | null | undefined): string | null => {
	if (!judgeVerdict) return null;
	const counts = new Map([["clear", 0], ["none", 0], ["worse", 0], ["inconclusive", 0]]);
	for (const item of judgeVerdict.cases) {
		counts.set(item.skillBenefit, (counts.get(item.skillBenefit) ?? 0) + 1);
	}
	return `clear ${counts.get("clear") ?? 0}, none ${counts.get("none") ?? 0}, worse ${counts.get("worse") ?? 0}, inconclusive ${counts.get("inconclusive") ?? 0}`;
};

export const readReportRows = async (filePath: string): Promise<Map<string, ReportRow>> => {
	if (!(await fileExists(filePath))) return new Map();
	const raw = await readFile(filePath, "utf-8");
	return parseStandaloneTable(raw.split("\n"));
};

const mergeReportRows = (params: {
	evaluations: CaseEvaluation[];
	allCases: ResolvedEvalCase[];
	previousRows: Map<string, ReportRow>;
	runTimestamp: string;
}): ReportRow[] => {
	const { evaluations, allCases, previousRows, runTimestamp } = params;
	const runDate = runDateFromTimestamp(runTimestamp);
	const updatedRows = new Map<string, ReportRow>();
	const caseById = new Map(allCases.map((evalCase) => [evalCase.id, evalCase]));
	const addMode = (map: Map<string, Set<string>>, caseId: string, mode: string) => {
		let set = map.get(caseId);
		if (!set) { set = new Set(); map.set(caseId, set); }
		set.add(mode);
	};
	const updatedModes = new Map<string, Set<string>>();
	const previousModes = new Map<string, Set<string>>();

	for (const row of previousRows.values()) addMode(previousModes, row.caseId, row.mode);

	for (const evaluation of evaluations) {
		const evalCase = caseById.get(evaluation.caseId);
		const taskStatus = taskStatusFor(evaluation, evalCase);
		const key = buildRowKey(evaluation.caseId, evaluation.mode);
		const tok = evaluation.result.tokens;
		const row: ReportRow = {
			caseId: evaluation.caseId,
			mode: evaluation.mode,
			status: taskStatus === "pass" ? "PASS" : "FAIL",
			judge: judgeLabelFor(evaluation, evalCase),
			apiCost: apiCostFromTokens(tok),
			cached: tok.cacheRead,
			turns: evaluation.result.turnBreakdown?.length ?? 0,
			skillsRead: evaluation.routing.readSkills.length,
			skillFilesRead: evaluation.routing.readSkillFiles.length,
			refsRead: evaluation.routing.readRefs.length,
			missingRefs: joinRoutingList(evaluation.routing.missingRefs),
			unexpectedRefs: joinRoutingList(evaluation.routing.unexpectedRefs),
			notes: taskNotesFor(evaluation, evalCase),
			run: runDate,
		};
		updatedRows.set(key, row);
		addMode(updatedModes, row.caseId, row.mode);
	}

	const caseIds = new Set([...allCases.map((c) => c.id), ...updatedModes.keys()]);

	const rows: ReportRow[] = [];
	const modeOrder = new Map(["single", "baseline", "interference"].map((mode, index) => [mode, index]));
	const sortedCaseIds = Array.from(caseIds).sort((a, b) => a.localeCompare(b));

	for (const caseId of sortedCaseIds) {
		const modes = new Set([...(previousModes.get(caseId) ?? []), ...(updatedModes.get(caseId) ?? [])]);
		if (modes.size === 0) modes.add("single");
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
						judge: "-",
						apiCost: 0,
					cached: 0,
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

const renderCaseTable = (rows: ReportRow[]): string => {
	const outputRows = rows.map((row) => {
		const status = normalizeStatus(row.status) || "";
		const cost = row.apiCost || 0;
		const cached = row.cached || 0;
		const turnCount = row.turns || 0;
			return `| ${row.caseId} | ${row.mode} | ${status} | ${row.judge} | ${cost} | ${cached} | ${turnCount} | ${row.skillsRead} | ${row.skillFilesRead} | ${row.refsRead} | ${row.missingRefs} | ${row.unexpectedRefs} | ${row.notes} | ${row.run} |`;
		});
	return [
		"| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...outputRows,
	].join("\n");
};

const renderTaskFailures = (rows: ReportRow[]): string => {
	const failures = rows.filter((item) => normalizeStatus(item.status) === "FAIL");
	if (failures.length === 0) return "No task failures.";
	return failures
		.map((item) => `- **${item.caseId}** (${item.mode}): ${item.notes || "failed"}`)
		.join("\n");
};

const renderComparisonOutcomes = (judgeVerdict: JudgeSuiteVerdict | null | undefined): string => {
	if (!judgeVerdict) return "No judge comparison verdict was produced.";
	return judgeVerdict.cases.map((testCase) => {
		const variants = testCase.variants
			.map((variant) => `${variant.tag}: ${variant.taskPass ? "task pass" : "task fail"} (${variant.rationale})`)
			.join("; ");
		return `- **${testCase.caseId}**: ${testCase.skillBenefit}; bundle ${testCase.bundlePass ? "pass" : "fail"}. ${variants}`;
	}).join("\n");
};

const collectSkillFeedback = (judgeVerdict: JudgeSuiteVerdict | null | undefined): string[] => {
	if (!judgeVerdict) return [];
	const seen = new Set<string>();
	const feedback: string[] = [];
	for (const item of [...judgeVerdict.skillFeedback, ...judgeVerdict.cases.flatMap((testCase) => testCase.skillFeedback)]) {
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		feedback.push(normalized);
	}
	return feedback;
};

const reportAlreadyHasSkillFeedback = (markdown: string): boolean =>
	/^#{2,3}\s+Skill Feedback\b/im.test(markdown);

export const buildReport = (params: {
	model: ModelSpec;
	commitSha: string;
	runTimestamp: string;
	evaluations: CaseEvaluation[];
	durationMs: number;
	allCases: ResolvedEvalCase[];
	previousRows: Map<string, ReportRow>;
	runScope: "full" | "partial";
	judgeVerdict?: JudgeSuiteVerdict | null;
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
		judgeVerdict,
		filter,
		limit,
		casesPathLabel,
	} = params;
	const costs = evaluations.map((item) => apiCostFromTokens(item.result.tokens));
	const stats = formatCostStats(costs);
	const rows = mergeReportRows({ evaluations, allCases, previousRows, runTimestamp });
	let rowPass = 0;
	let rowFail = 0;
	let rowSkip = 0;
	for (const item of rows) {
		const s = normalizeStatus(item.status);
		if (s === "PASS") rowPass++;
		else if (s === "FAIL") rowFail++;
		else if (s === "SKIP") rowSkip++;
	}
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
			`- Runs executed: ${executedCases} (${executedRows} rows)`,
			`- Task rows: ${totalRows} (pass ${rowPass}, fail ${rowFail}, skip ${rowSkip})`,
			`- Runs in spec: ${totalCases}`,
			`- Duration: ${formatDuration(durationMs)}`,
			`- Token stats (this run): cost max ${stats.max}, cost median ${stats.median}, cost p95 ${stats.p95}`,
		];
		const comparisonStats = formatComparisonStats(judgeVerdict);
		if (judgeVerdict) {
			headerLines.push(`- Suite verdict: ${judgeVerdict.pass ? "PASS" : "FAIL"}`);
		}
		if (comparisonStats) {
			headerLines.push(`- Judge comparison: ${comparisonStats}`);
		}
	if (casesPathLabel) {
		headerLines.splice(6, 0, `- Cases path: ${casesPathLabel}`);
	}

	const reportParts = [...headerLines, ""];
		if (judgeVerdict) {
			const feedback = collectSkillFeedback(judgeVerdict);
			const reportMarkdown = judgeVerdict.reportMarkdown.trim();
			reportParts.push(JUDGE_REPORT_START);
			const judgeStatus = judgeVerdict.pass ? "PASS" : "FAIL";
			reportParts.push("## Judge Report");
		reportParts.push("");
		reportParts.push(`- Suite verdict: ${judgeStatus}`);
		reportParts.push(`- Judge token cost: ${judgeVerdict.judgeTokens.totalTokens}`);
		reportParts.push("");
			reportParts.push(reportMarkdown);
			if (feedback.length > 0 && !reportAlreadyHasSkillFeedback(reportMarkdown)) {
				reportParts.push("");
				reportParts.push("## Skill Feedback");
				reportParts.push("");
				reportParts.push(feedback.map((item) => `- ${item}`).join("\n"));
			}
			reportParts.push("");
			reportParts.push(JUDGE_REPORT_END);
			reportParts.push("");
		}
	reportParts.push("## Case Rows");
	reportParts.push(UNPAIRED_TABLE_SENTINEL);
	reportParts.push(renderCaseTable(rows));
	reportParts.push("");
		reportParts.push("## Comparison Outcomes");
		reportParts.push(renderComparisonOutcomes(judgeVerdict));
		reportParts.push("");
		reportParts.push("## Task Failures");
		reportParts.push(renderTaskFailures(rows));
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
