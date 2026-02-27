import { readFile } from "node:fs/promises";
import type { EvalCase } from "./types.js";

export const loadCases = async (filePath: string): Promise<EvalCase[]> => {
	const raw = await readFile(filePath, "utf-8");
	const cases: EvalCase[] = [];
	const lines = raw.split("\n");
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return;
		try {
			const parsed = JSON.parse(trimmed) as EvalCase;
			cases.push({
				...parsed,
				expectedSkills: parsed.expectedSkills ?? [],
				disallowedSkills: parsed.disallowedSkills ?? [],
				expectedRefs: parsed.expectedRefs ?? [],
				assertions: parsed.assertions ?? [],
			});
		} catch (error) {
			throw new Error(`Failed to parse case on line ${index + 1}: ${error}`);
		}
	});
	return cases;
};

export const filterCases = (cases: EvalCase[], filter?: string, limit?: number): EvalCase[] => {
	let filtered = cases;
	if (filter) {
		const token = filter.toLowerCase();
		filtered = filtered.filter((item) =>
			item.id.toLowerCase().includes(token) || item.suite.toLowerCase().includes(token),
		);
	}
	if (limit && Number.isFinite(limit)) {
		return filtered.slice(0, limit);
	}
	return filtered;
};
