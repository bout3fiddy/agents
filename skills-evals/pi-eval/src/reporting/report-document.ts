/**
 * Shared markdown report table parsing primitives.
 *
 * Both report.ts (read/merge) and purge-report.ts (row removal) need to
 * locate tables, extract cells, and iterate rows inside generated markdown
 * reports. This module centralises those operations so the two consumers
 * stay in sync.
 */

export const UNPAIRED_TABLE_SENTINEL = "<!-- UNPAIRED_TABLE_START -->";

export const normalizeStatus = (value: string): string => value.trim().toUpperCase();

// ── Cell / row helpers ──────────────────────────────────────────────────

/** Split a markdown table row into trimmed cell strings (strips outer `|`). */
export const extractRowCells = (line: string): string[] =>
	line.split("|").slice(1, -1).map((cell) => cell.trim());

export const safeParseInt = (value: string): number => {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : 0;
};

export const cellStr = (cells: string[], idx: number, fallback: string): string =>
	idx >= 0 ? (cells[idx] ?? fallback) : fallback;

// ── Table boundary discovery ────────────────────────────────────────────

export type TableBoundaries = {
	sentinelIndex: number; // -1 when absent
	headerIndex: number;   // -1 when no table found
	dataStart: number;     // headerIndex + 2 (first data row)
};

/**
 * Locate the sentinel comment, header row, and first data row inside
 * `lines`.  Uses the sentinel (if present) as a search-start fence so
 * tables above it are ignored.
 */
export const findTableBoundaries = (
	lines: string[],
	headerPrefix = "| Case ",
): TableBoundaries => {
	const sentinelIndex = lines.findIndex((line) => line.trim() === UNPAIRED_TABLE_SENTINEL);
	const searchStart = sentinelIndex >= 0 ? sentinelIndex : 0;
	const headerIndex = lines.findIndex(
		(line, idx) => idx >= searchStart && line.trimStart().startsWith(headerPrefix),
	);
	return {
		sentinelIndex,
		headerIndex,
		dataStart: headerIndex >= 0 ? headerIndex + 2 : -1,
	};
};

// ── Column index resolver ───────────────────────────────────────────────

/**
 * Build a name→index lookup from the header row's cells.
 * Comparison is case-insensitive.
 */
export const buildColumnIndex = (headerCells: string[]): ((name: string) => number) => {
	const lower = headerCells.map((c) => c.toLowerCase());
	return (name: string) => lower.indexOf(name.toLowerCase());
};

// ── Row type ────────────────────────────────────────────────────────────

export type ReportRow = {
	caseId: string;
	mode: string;
	status: string;
	apiCost: number;
	cached: number;
	turns: number;
	skillsRead: number;
	skillFilesRead: number;
	refsRead: number;
	missingRefs: string;
	unexpectedRefs: string;
	notes: string;
	run: string;
};

export const buildRowKey = (caseId: string, mode: string): string => `${caseId}::${mode}`;

// ── Standalone-table parser ─────────────────────────────────────────────

/**
 * Parse the standalone results table from `lines` into a keyed map.
 * This is the shared core used by both `readReportRows` (report.ts) and
 * any consumer that needs structured access to existing table data.
 */
export const parseStandaloneTable = (lines: string[]): Map<string, ReportRow> => {
	const rows = new Map<string, ReportRow>();
	const { headerIndex, dataStart } = findTableBoundaries(lines);
	if (headerIndex < 0 || dataStart < 0) return rows;

	const headerCells = extractRowCells(lines[headerIndex]);
	const col = buildColumnIndex(headerCells);

	const caseIdx = col("Case");
	const modeIdx = col("Mode");
	const statusIdx = col("Status");
	const costIdx = col("Cost");
	const cachedIdx = col("Cached");
	const tokensIdx = col("Tokens"); // backward compat: old reports use "Tokens"
	const turnsIdx = col("Turns");
	const skillsReadIdx = col("Skills Read");
	const skillFilesReadIdx = col("Skill Files Read");
	const refsReadIdx = col("Refs Read");
	const missingRefsIdx = col("Missing Refs");
	const unexpectedRefsIdx = col("Unexpected Refs");
	const notesIdx = col("Notes");
	const runIdx = col("Run");
	if (caseIdx < 0 || modeIdx < 0) return rows;
	const primaryCostIdx = costIdx >= 0 ? costIdx : tokensIdx;
	const requiredMax = Math.max(caseIdx, modeIdx, statusIdx, primaryCostIdx, notesIdx, runIdx);

	for (let i = dataStart; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (!line.trim().startsWith("|")) break;
		const cells = extractRowCells(line);
		if (cells.length <= requiredMax) continue;
		const caseId = cells[caseIdx] ?? "";
		const mode = cells[modeIdx] ?? "";
		if (!caseId || !mode) continue;
		const parsedCost = safeParseInt(cellStr(cells, primaryCostIdx, "0"));
		rows.set(buildRowKey(caseId, mode), {
			caseId,
			mode,
			status: cells[statusIdx] ?? "",
			apiCost: parsedCost,
			cached: safeParseInt(cellStr(cells, cachedIdx, "0")),
			turns: safeParseInt(cellStr(cells, turnsIdx, "0")),
			skillsRead: safeParseInt(cellStr(cells, skillsReadIdx, "0")),
			skillFilesRead: safeParseInt(cellStr(cells, skillFilesReadIdx, "0")),
			refsRead: safeParseInt(cellStr(cells, refsReadIdx, "0")),
			missingRefs: cellStr(cells, missingRefsIdx, "-"),
			unexpectedRefs: cellStr(cells, unexpectedRefsIdx, "-"),
			notes: cells[notesIdx] ?? "",
			run: cellStr(cells, runIdx, "-"),
		});
	}

	return rows;
};

// ── Header-stats recalculation ──────────────────────────────────────────

/**
 * Recalculate `Case rows:` and `Cases in spec:` header lines in-place
 * based on remaining table rows (both standalone and bundle variant tables).
 */
export const recalculateHeaderStats = (lines: string[]): void => {
	let rowPass = 0;
	let rowFail = 0;
	let rowSkip = 0;
	const caseIds = new Set<string>();

	// Count standalone table rows
	const { headerIndex } = findTableBoundaries(lines);
	if (headerIndex >= 0) {
		const col = buildColumnIndex(extractRowCells(lines[headerIndex]));
		const caseIdx = col("Case");
		const statusIdx = col("Status");
		for (let i = headerIndex + 2; i < lines.length; i++) {
			const line = lines[i];
			if (!line.trim().startsWith("|")) break;
			const cells = extractRowCells(line);
			const caseId = cellStr(cells, caseIdx, "");
			const status = cellStr(cells, statusIdx, "");
			if (!caseId) continue;
			caseIds.add(caseId);
			const s = normalizeStatus(status);
			if (s === "PASS") rowPass++;
			else if (s === "FAIL") rowFail++;
			else if (s === "SKIP") rowSkip++;
		}
	}

	// Count bundle variant table rows (tables under ### headings)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("| Variant ")) continue;
		const varCol = buildColumnIndex(extractRowCells(line));
		const variantIdx = varCol("Variant");
		const varStatusIdx = varCol("Status");
		for (let j = i + 2; j < lines.length; j++) {
			const row = lines[j];
			if (!row.trim().startsWith("|")) break;
			const cells = extractRowCells(row);
			const variantId = cellStr(cells, variantIdx, "");
			const status = cellStr(cells, varStatusIdx, "");
			if (!variantId) continue;
			caseIds.add(variantId);
			const s = normalizeStatus(status);
			if (s === "PASS") rowPass++;
			else if (s === "FAIL") rowFail++;
			else if (s === "SKIP") rowSkip++;
		}
	}

	const totalRows = rowPass + rowFail + rowSkip;
	const totalCases = caseIds.size;

	for (let i = 0; i < Math.min(lines.length, 20); i++) {
		if (lines[i].startsWith("- Case rows:")) {
			lines[i] = `- Case rows: ${totalRows} (pass ${rowPass}, fail ${rowFail}, skip ${rowSkip})`;
		} else if (lines[i].startsWith("- Cases in spec:")) {
			lines[i] = `- Cases in spec: ${totalCases}`;
		}
	}
};
