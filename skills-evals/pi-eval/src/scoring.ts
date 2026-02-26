import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CaseEvaluation, CaseRunResult, EvalCase } from "./types.js";
import { normalizePath } from "./utils.js";

export const buildCaseResult = (
	caseId: string,
	result: CaseRunResult,
	evalCase: EvalCase,
	reasons: string[],
): CaseEvaluation => ({
	caseId,
	suite: evalCase.suite,
	mode: "single",
	status: reasons.length === 0 ? "pass" : "fail",
	reasons,
	result,
	expectedSkills: evalCase.expectedSkills,
	disallowedSkills: evalCase.disallowedSkills,
	expectedRefs: evalCase.expectedRefs,
	assertions: evalCase.assertions ?? [],
	tokenBudget: evalCase.tokenBudget ?? null,
});

const normalizeRefPath = (ref: string): string =>
	normalizePath(ref).trim().replace(/^\.\/+/, "");

export const evaluateCase = async (
	evalCase: EvalCase,
	result: CaseRunResult,
): Promise<CaseEvaluation> => {
	const reasons: string[] = [];
	const useAttempts = result.dryRun;
	const invokedSkills = useAttempts ? result.skillAttempts : result.skillInvocations;
	const invokedRefs = useAttempts ? result.refAttempts : result.refInvocations;
	const normalizedInvokedRefs = invokedRefs.map(normalizeRefPath);

	for (const skill of evalCase.expectedSkills ?? []) {
		if (!invokedSkills.includes(skill)) reasons.push(`missing skill: ${skill}`);
	}
	for (const skill of evalCase.disallowedSkills ?? []) {
		if (invokedSkills.includes(skill)) reasons.push(`unexpected skill: ${skill}`);
	}
	for (const ref of evalCase.expectedRefs ?? []) {
		const normalizedExpected = normalizeRefPath(ref);
		const matched = normalizedInvokedRefs.some(
			(item) => item === normalizedExpected || item.endsWith(`/${normalizedExpected}`),
		);
		if (!matched) reasons.push(`missing reference: ${ref}`);
	}

	const fileAssertions = evalCase.fileAssertions ?? [];
	if (fileAssertions.length > 0) {
		if (!result.workspaceDir) {
			reasons.push("missing workspace for file assertions");
		} else {
			for (const assertion of fileAssertions) {
				const targetPath = path.join(result.workspaceDir, assertion.path);
				let content = "";
				try {
					content = await readFile(targetPath, "utf-8");
				} catch {
					reasons.push(`missing file: ${assertion.path}`);
					continue;
				}
				for (const needle of assertion.mustContain ?? []) {
					if (!content.includes(needle)) {
						reasons.push(`file assertion failed: ${assertion.path} missing ${needle}`);
					}
				}
				for (const needle of assertion.mustNotContain ?? []) {
					if (content.includes(needle)) {
						reasons.push(`file assertion failed: ${assertion.path} contains ${needle}`);
					}
				}
			}
		}
	}

	const outputText = result.outputText ?? "";
	for (const assertion of evalCase.assertions ?? []) {
		if (assertion.startsWith("must_contain:")) {
			const needle = assertion.slice("must_contain:".length);
			if (!outputText.includes(needle)) reasons.push(`assertion failed: ${assertion}`);
			continue;
		}
		if (assertion.startsWith("must_not_contain:")) {
			const needle = assertion.slice("must_not_contain:".length);
			if (outputText.includes(needle)) reasons.push(`assertion failed: ${assertion}`);
			continue;
		}
		reasons.push(`unknown assertion: ${assertion}`);
	}

	const budget = evalCase.tokenBudget ?? null;
	if (budget !== null && result.tokens.totalTokens > budget) {
		reasons.push(`token budget exceeded (${result.tokens.totalTokens} > ${budget})`);
	}
	if (result.errors.length > 0) {
		reasons.push(...result.errors.map((err) => `run error: ${err}`));
	}
	return buildCaseResult(evalCase.id, result, evalCase, reasons);
};
