/** Assembles CaseEvaluation from run results. No pass/fail logic — judge decides. */
import type {
	CaseEvaluation,
	CaseRunResult,
	EvalCase,
	FailureReason,
	RoutingScorecard,
} from "../../data/types.js";
import { uniqueSorted } from "../../data/utils.js";
import { normalizePath } from "../policy/path-policy.js";

const normalizeRefPath = (ref: string): string =>
	normalizePath(ref).trim().replace(/^\.\/+/, "");

const buildRoutingScorecard = (result: CaseRunResult): RoutingScorecard => {
	const attemptedSkills = uniqueSorted(result.skillAttempts ?? []);
	const successfulSkills = uniqueSorted(result.skillInvocations ?? []);
	const deniedSkills = uniqueSorted(result.skillDenied ?? []);
	const attemptedSkillFiles = uniqueSorted(result.skillFileAttempts ?? []);
	const successfulSkillFiles = uniqueSorted(result.skillFileInvocations ?? []);
	const deniedSkillFiles = uniqueSorted(result.skillFileDenied ?? []);
	const attemptedRefs = uniqueSorted((result.refAttempts ?? []).map(normalizeRefPath));
	const successfulRefs = uniqueSorted((result.refInvocations ?? []).map(normalizeRefPath));
	const deniedRefs = uniqueSorted((result.refDenied ?? []).map(normalizeRefPath));
	const invokedSkills = result.dryRun ? attemptedSkills : successfulSkills;
	const invokedSkillFiles = result.dryRun ? attemptedSkillFiles : successfulSkillFiles;
	const invokedRefs = result.dryRun ? attemptedRefs : successfulRefs;

	return {
		readSkills: invokedSkills,
		readSkillFiles: invokedSkillFiles,
		readRefs: invokedRefs,
		attemptedSkills,
		successfulSkills,
		deniedSkills,
		attemptedSkillFiles,
		successfulSkillFiles,
		deniedSkillFiles,
		attemptedRefs,
		successfulRefs,
		deniedRefs,
		missingSkillFileReads: [],
		missingRefs: [],
		unexpectedRefs: [],
	};
};

export const buildCaseResult = (
	caseId: string,
	result: CaseRunResult,
	evalCase: EvalCase,
	failureReasons: FailureReason[],
): CaseEvaluation => ({
	caseId,
	suite: evalCase.suite,
	mode: "single",
	status: failureReasons.length === 0 ? "pass" : "fail",
	reasons: failureReasons.map((f) => `${f.category}: ${f.message}`),
	failureReasons,
	result,
	expectedSkills: evalCase.expectedSkills,
	disallowedSkills: evalCase.disallowedSkills,
	expectedRefs: evalCase.expectedRefs,
	routing: buildRoutingScorecard(result),
	assertions: evalCase.assertions ?? [],
	tokenBudget: evalCase.tokenBudget ?? null,
});

export const assembleEvaluation = (
	evalCase: EvalCase,
	result: CaseRunResult,
): CaseEvaluation =>
	buildCaseResult(evalCase.id, result, evalCase, []);
