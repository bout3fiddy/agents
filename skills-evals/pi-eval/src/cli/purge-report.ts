#!/usr/bin/env bun
/**
 * Purges eval case rows/sections from markdown report files.
 * Usage: bun run purge-report.ts --case CASE_ID --reports-dir PATH [--variants tag1,tag2] [--dry-run]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	UNPAIRED_TABLE_SENTINEL,
	extractRowCells,
	findTableBoundaries,
	normalizeStatus,
	recalculateHeaderStats,
} from "../reporting/report-document.js";

// ---------------------------------------------------------------------------
// Core purge logic (exported for testing)
// ---------------------------------------------------------------------------

export type PurgeResult = {
	removedRows: string[];
	removedBundleSections: string[];
	updatedContent: string;
};

/**
 * Remove rows matching `casePatterns` from the standalone table and bundle
 * subsections matching `bundleId` from the Bundle Evaluations section.
 * Recalculates header stats after removal.
 */
export const purgeRowsFromReport = (
	content: string,
	casePatterns: Set<string>,
	bundleId: string | null,
): PurgeResult => {
	const removedRows: string[] = [];
	const removedBundleSections: string[] = [];
	const lines = content.split("\n");

	// --- 1. Remove matching rows from the standalone table ---
	const { headerIndex: tableHeaderIdx, dataStart } = findTableBoundaries(lines);

	if (tableHeaderIdx >= 0) {
		const toRemove: number[] = [];
		for (let i = dataStart; i < lines.length; i++) {
			const line = lines[i];
			if (!line.trim().startsWith("|")) break;
			const cells = extractRowCells(line);
			const caseCell = cells[0] ?? "";
			if (casePatterns.has(caseCell)) {
				toRemove.push(i);
				removedRows.push(caseCell);
			}
		}
		// Remove in reverse to preserve indices
		for (let j = toRemove.length - 1; j >= 0; j--) {
			lines.splice(toRemove[j], 1);
		}
	}

	// --- 2. Remove bundle subsection under ## Bundle Evaluations ---
	if (bundleId) {
		const bundleSectionIdx = lines.findIndex((l) => l.trim() === "## Bundle Evaluations");
		if (bundleSectionIdx >= 0) {
			const bundleHeadingPrefix = `### ${bundleId}:`;
			let i = bundleSectionIdx + 1;
			while (i < lines.length) {
				const line = lines[i];
				// Stop if we hit the next ## section (not ###)
				if (line.startsWith("## ") && !line.startsWith("### ")) break;

				if (line.startsWith(bundleHeadingPrefix)) {
					// Find extent: from this heading to next ### or --- (exclusive) or next ##
					const sectionStart = i;
					let sectionEnd = i + 1;
					while (sectionEnd < lines.length) {
						const nextLine = lines[sectionEnd];
						if (nextLine.startsWith("### ") || (nextLine.startsWith("## ") && !nextLine.startsWith("### "))) break;
						// Include trailing --- separator
						if (nextLine.trim() === "---") {
							sectionEnd++;
							// Also consume blank line after ---
							while (sectionEnd < lines.length && lines[sectionEnd].trim() === "") sectionEnd++;
							break;
						}
						sectionEnd++;
					}
					removedBundleSections.push(bundleId);
					lines.splice(sectionStart, sectionEnd - sectionStart);
					// Don't advance i since we spliced
					continue;
				}
				i++;
			}

			// If Bundle Evaluations section is now empty (only heading + blank lines),
			// remove it entirely
			let hasContent = false;
			for (let j = bundleSectionIdx + 1; j < lines.length; j++) {
				const l = lines[j];
				if (l.startsWith("## ") && !l.startsWith("### ")) break;
				if (l.trim() !== "") { hasContent = true; break; }
			}
			if (!hasContent) {
				// Find extent of empty section
				let endIdx = bundleSectionIdx + 1;
				while (endIdx < lines.length) {
					if (lines[endIdx].startsWith("## ") && !lines[endIdx].startsWith("### ")) break;
					endIdx++;
				}
				lines.splice(bundleSectionIdx, endIdx - bundleSectionIdx);
			}
		}
	}

	// --- 3. Recalculate header stats (re-find sentinel since splices shifted indices) ---
	recalculateHeaderStats(lines);

	return {
		removedRows,
		removedBundleSections,
		updatedContent: lines.join("\n"),
	};
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const idx = args.indexOf(name);
		return idx >= 0 ? args[idx + 1] : undefined;
	};
	const has = (name: string): boolean => args.includes(name);

	const caseId = flag("--case");
	const reportsDir = flag("--reports-dir");
	const variantsRaw = flag("--variants");
	const dryRun = has("--dry-run");

	if (!caseId || !reportsDir) {
		console.error("Usage: purge-report.ts --case CASE_ID --reports-dir PATH [--variants t1,t2] [--dry-run]");
		process.exit(1);
	}

	// Build case patterns to match
	const patterns = new Set<string>();
	let bundleId: string | null = null;

	if (variantsRaw) {
		// Bundle: match variant case IDs like "CD-015:skill"
		bundleId = caseId;
		for (const tag of variantsRaw.split(",")) {
			patterns.add(`${caseId}:${tag.trim()}`);
		}
	} else {
		// Standalone: match exact case ID
		patterns.add(caseId);
	}

	const mdFiles = (await readdir(reportsDir))
		.filter((f) => f.endsWith(".md"))
		.sort();

	for (const file of mdFiles) {
		const filePath = path.join(reportsDir, file);
		const content = await readFile(filePath, "utf-8");
		const result = purgeRowsFromReport(content, patterns, bundleId);

		const anyChanges = result.removedRows.length > 0 || result.removedBundleSections.length > 0;
		if (!anyChanges) continue;

		if (dryRun) {
			console.log(`[dry-run] ${file}:`);
			for (const row of result.removedRows) console.log(`  remove row: ${row}`);
			for (const sec of result.removedBundleSections) console.log(`  remove bundle section: ${sec}`);
		} else {
			await writeFile(filePath, result.updatedContent);
			console.log(`Updated ${file}: removed ${result.removedRows.length} row(s), ${result.removedBundleSections.length} bundle section(s)`);
		}
	}
}
