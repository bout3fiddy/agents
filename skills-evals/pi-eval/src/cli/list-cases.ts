#!/usr/bin/env bun
/**
 * Lists all defined eval cases from the eval-cases/ directory.
 * Usage: bun run skills-evals/pi-eval/src/cli/list-cases.ts [--cases-dir PATH]
 */
import path from "node:path";
import { loadCases } from "../data/cases.js";

const casesDir = (() => {
	const idx = process.argv.indexOf("--cases-dir");
	if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
	return path.resolve(import.meta.dirname, "../../../fixtures/eval-cases");
})();

const printTable = async () => {
	const { cases, bundles } = await loadCases(casesDir);

	type Row = { id: string; suite: string; type: string; variants: string };
	const rows: Row[] = [];
	const seen = new Set<string>();

	for (const c of cases) {
		if (c.bundleId) {
			if (seen.has(c.bundleId)) continue;
			seen.add(c.bundleId);
			const bundle = bundles.get(c.bundleId);
			rows.push({
				id: c.bundleId,
				suite: c.suite,
				type: "bundle",
				variants: bundle ? bundle.variantTags.join(", ") : "-",
			});
		} else {
			rows.push({ id: c.id, suite: c.suite, type: "standalone", variants: "-" });
		}
	}

	const columns = ["id", "suite", "type", "variants"] as const;
	const header = ["ID", "Suite", "Type", "Variants"];
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => r[columns[i]].length)),
	);
	const pad = (s: string, w: number) => s.padEnd(w);

	console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) {
		console.log(columns.map((col, i) => pad(row[col], widths[i])).join("  "));
	}
	console.log(`\n${rows.length} case(s)`);
};

if (import.meta.main) {
	await printTable();
}
