import { createHash } from "node:crypto";
import type {
	CaseEvaluation,
	CaseRunResult,
	EvalCase,
	FailureReason,
	RoutingScorecard,
} from "../../data/types.js";
import { uniqueSorted } from "../../data/utils.js";
import { normalizePath } from "../policy/path-policy.js";

export const POLICY_DENY_ASSERTION_PREFIX = "must_trigger_policy_deny:";

const normalizeRefPath = (ref: string): string =>
	normalizePath(ref).trim().replace(/^\.\/+/, "");

export const buildManifestHash = (params: {
	caseId: string;
	profile: string;
	availableSkills: string[];
}): string => {
	const payload = JSON.stringify({
		caseId: params.caseId,
		profile: params.profile,
		availableSkills: [...params.availableSkills].sort(),
	});
	return createHash("sha256").update(payload).digest("hex");
};

export const buildCaseResult = (
	caseId: string,
	result: CaseRunResult,
	evalCase: EvalCase,
	failureReasons: FailureReason[],
	routing?: RoutingScorecard,
): CaseEvaluation => ({
	caseId,
	suite: evalCase.suite,
	mode: "single",
	status: failureReasons.length === 0 ? "pass" : "fail",
	reasons: failureReasons.map((failure) => `${failure.category}: ${failure.message}`),
	failureReasons,
	result,
	expectedSkills: evalCase.expectedSkills,
	disallowedSkills: evalCase.disallowedSkills,
	expectedRefs: evalCase.expectedRefs,
	routing: routing ?? buildRoutingScorecard(result),
	assertions: evalCase.assertions ?? [],
	tokenBudget: evalCase.tokenBudget ?? null,
});

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

/** Assemble a CaseEvaluation from run results. No pass/fail logic — judge decides. */
export const assembleEvaluation = (
	evalCase: EvalCase,
	result: CaseRunResult,
): CaseEvaluation =>
	buildCaseResult(evalCase.id, result, evalCase, [], buildRoutingScorecard(result));
