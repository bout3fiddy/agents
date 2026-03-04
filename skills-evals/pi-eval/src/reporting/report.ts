import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiCostFromTokens, type CaseEvaluation, type EvalBundle, type JudgeBundleVerdict, type ModelSpec, type ResolvedEvalCase } from "../data/types.js";
import { ensureDir, fileExists, formatDuration, median, percentile } from "../data/utils.js";
import {
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
	const addMode = (map: Map<string, Set<string>>, caseId: string, mode: string) => {
		let set = map.get(caseId);
		if (!set) { set = new Set(); map.set(caseId, set); }
		set.add(mode);
	};
	const updatedModes = new Map<string, Set<string>>();
	const previousModes = new Map<string, Set<string>>();

	for (const row of previousRows.values()) addMode(previousModes, row.caseId, row.mode);

	for (const evaluation of evaluations) {
		const key = buildRowKey(evaluation.caseId, evaluation.mode);
		const tok = evaluation.result.tokens;
		const row: ReportRow = {
			caseId: evaluation.caseId,
			mode: evaluation.mode,
			status: evaluation.status === "pass" ? "PASS" : "FAIL",
			apiCost: apiCostFromTokens(tok),
			cached: tok.cacheRead,
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

type BundleSection = {
	bundleId: string;
	variantRows: ReportRow[];
	verdict: JudgeBundleVerdict;
	notes: string;
};

const renderBundleVariantTable = (variantRows: ReportRow[]): string => {
	const header = "| Variant | Status | Cost | Cached | Turns | Skills Read | Refs Read |";
	const separator = "| --- | --- | --- | --- | --- | --- | --- |";
	const lines = variantRows.map(
		(row) => `| ${row.caseId} | ${normalizeStatus(row.status)} | ${row.apiCost} | ${row.cached} | ${row.turns} | ${row.skillsRead} | ${row.refsRead} |`,
	);
	return [header, separator, ...lines].join("\n");
};

const renderDimensionsTable = (verdict: JudgeBundleVerdict): string => {
	const tags = verdict.variantTags;
	const header = `| Dimension | ${tags.join(" | ")} | Rationale |`;
	const separator = `| --- | ${tags.map(() => "---").join(" | ")} | --- |`;
	const rows = verdict.dimensions.map((d) => {
		const scores = tags.map((tag) => String(d.scores[tag] ?? 0));
		return `| ${d.name} | ${scores.join(" | ")} | ${d.rationale} |`;
	});
	return [header, separator, ...rows].join("\n");
};

const renderBundleSections = (sections: BundleSection[]): string => {
	if (sections.length === 0) return "";
	const parts: string[] = ["## Bundle Evaluations", ""];
	for (const section of sections) {
		parts.push(`### ${section.bundleId}: ${section.notes || "bundle comparison"}`);
		parts.push(renderBundleVariantTable(section.variantRows));
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
		const cost = row.apiCost || 0;
		const cached = row.cached || 0;
		const turnCount = row.turns || 0;
		return `| ${row.caseId} | ${row.mode} | ${status} | ${cost} | ${cached} | ${turnCount} | ${row.skillsRead} | ${row.skillFilesRead} | ${row.refsRead} | ${row.missingRefs} | ${row.unexpectedRefs} | ${row.notes} | ${row.run} |`;
	});
	return [
		"| Case | Mode | Status | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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

const collectBundleSections = (
	evaluations: CaseEvaluation[],
	allRows: ReportRow[],
	bundles: Map<string, EvalBundle>,
): { sections: BundleSection[]; bundleCaseIds: Set<string> } => {
	const bundleCaseIds = new Set<string>();
	const sections: BundleSection[] = [];
	const seenBundles = new Set<string>();
	const rowByCaseId = new Map(allRows.map((r) => [r.caseId, r]));

	for (const evaluation of evaluations) {
		if (!evaluation.judgeVerdict) continue;
		const verdict = evaluation.judgeVerdict;
		const bundleId = verdict.bundleId;
		if (seenBundles.has(bundleId)) continue;
		seenBundles.add(bundleId);

		const bundle = bundles.get(bundleId);
		if (!bundle) continue;

		const variantCaseIds = bundle.variantTags.map((tag) => `${bundleId}:${tag}`);
		const variantRows = variantCaseIds
			.map((caseId) => rowByCaseId.get(caseId))
			.filter((r): r is ReportRow => r !== undefined);
		if (variantRows.length === 0) continue;

		sections.push({ bundleId, variantRows, verdict, notes: variantRows[0]?.notes ?? "" });
		for (const caseId of variantCaseIds) bundleCaseIds.add(caseId);
	}
	return { sections, bundleCaseIds };
};

export const buildReport = (params: {
	model: ModelSpec;
	commitSha: string;
	runTimestamp: string;
	evaluations: CaseEvaluation[];
	durationMs: number;
	allCases: ResolvedEvalCase[];
	previousRows: Map<string, ReportRow>;
	runScope: "full" | "partial";
	bundles: Map<string, EvalBundle>;
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
		bundles,
		filter,
		limit,
		casesPathLabel,
	} = params;
	const costs = evaluations.map((item) => apiCostFromTokens(item.result.tokens));
	const stats = formatCostStats(costs);
	const rows = mergeReportRows({ evaluations, allCases, previousRows, runTimestamp });
	const { sections, bundleCaseIds } = collectBundleSections(evaluations, rows, bundles);
	const standaloneRows = rows.filter((row) => !bundleCaseIds.has(row.caseId));
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
		`- Cases executed: ${executedCases} (${executedRows} rows)`,
		`- Case rows: ${totalRows} (pass ${rowPass}, fail ${rowFail}, skip ${rowSkip})`,
		`- Cases in spec: ${totalCases}`,
		`- Duration: ${formatDuration(durationMs)}`,
		`- Token stats (this run): cost max ${stats.max}, cost median ${stats.median}, cost p95 ${stats.p95}`,
	];
	if (casesPathLabel) {
		headerLines.splice(6, 0, `- Cases path: ${casesPathLabel}`);
	}

	const reportParts = [...headerLines, ""];
	if (sections.length > 0) {
		reportParts.push(renderBundleSections(sections));
	}
	reportParts.push("## Standalone Results");
	reportParts.push(UNPAIRED_TABLE_SENTINEL);
	reportParts.push(renderCaseTable(standaloneRows));
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
