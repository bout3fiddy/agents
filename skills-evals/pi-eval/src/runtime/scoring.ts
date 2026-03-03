import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
	BootstrapProfile,
	CaseEvaluation,
	CaseRunResult,
	EvalCase,
	FailureCategory,
	FailureReason,
	RoutingScorecard,
} from "../data/types.js";
import { normalizePath } from "../data/utils.js";

const uniqueSorted = (values: string[]): string[] =>
	Array.from(
		new Set(
			values
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	).sort((a, b) => a.localeCompare(b));

const formatList = (values: string[]): string => `[${values.join(", ")}]`;

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
	routing: routing ?? {
		readSkills: uniqueSorted(result.skillInvocations ?? []),
		readSkillFiles: uniqueSorted(result.skillFileInvocations ?? []),
		readRefs: uniqueSorted((result.refInvocations ?? []).map(normalizeRefPath)),
		attemptedSkills: uniqueSorted(result.skillAttempts ?? []),
		successfulSkills: uniqueSorted(result.skillInvocations ?? []),
		deniedSkills: uniqueSorted(result.skillDenied ?? []),
		attemptedSkillFiles: uniqueSorted(result.skillFileAttempts ?? []),
		successfulSkillFiles: uniqueSorted(result.skillFileInvocations ?? []),
		deniedSkillFiles: uniqueSorted(result.skillFileDenied ?? []),
		attemptedRefs: uniqueSorted((result.refAttempts ?? []).map(normalizeRefPath)),
		successfulRefs: uniqueSorted((result.refInvocations ?? []).map(normalizeRefPath)),
		deniedRefs: uniqueSorted((result.refDenied ?? []).map(normalizeRefPath)),
		missingSkillFileReads: [],
		missingRefs: [],
		unexpectedRefs: [],
	},
	assertions: evalCase.assertions ?? [],
	tokenBudget: evalCase.tokenBudget ?? null,
});

const normalizeRefPath = (ref: string): string =>
	normalizePath(ref).trim().replace(/^\.\/+/, "");

const isRefMatch = (observedNormalizedRef: string, expectedNormalizedRef: string): boolean => {
	if (
		observedNormalizedRef === expectedNormalizedRef ||
		observedNormalizedRef.endsWith(`/${expectedNormalizedRef}`)
	) {
		return true;
	}
	if (!expectedNormalizedRef.endsWith("/index.md")) return false;
	const expectedDir = expectedNormalizedRef.slice(0, -"/index.md".length);
	return (
		observedNormalizedRef === expectedDir ||
		observedNormalizedRef.startsWith(`${expectedDir}/`) ||
		observedNormalizedRef.includes(`/${expectedDir}/`)
	);
};

const isExpectedRefRead = (expectedNormalizedRef: string, observedRefs: string[]): boolean =>
	observedRefs.some((observedRef) => isRefMatch(observedRef, expectedNormalizedRef));

type EvaluateCaseOptions = {
	expectedBootstrapManifestHash?: string | null;
};

const POLICY_FAILURE_PATTERNS = [
	/forbidden read/i,
	/FORBIDDEN_WORKSPACE_VIOLATION/i,
	/policy deny triggered in no_payload profile/i,
];

const isPolicyFailure = (message: string): boolean =>
	POLICY_FAILURE_PATTERNS.some((pattern) => pattern.test(message));

const buildManifestHash = (params: {
	caseId: string;
	profile: BootstrapProfile;
	availableSkills: string[];
}): string => {
	const payload = JSON.stringify({
		caseId: params.caseId,
		profile: params.profile,
		availableSkills: [...params.availableSkills].sort(),
	});
	return createHash("sha256").update(payload).digest("hex");
};

const isPathNeedleMatch = (message: string, needle: string): boolean => {
	const trimmedNeedle = needle.trim();
	if (trimmedNeedle.length === 0) return true;
	const normalizedNeedle = normalizeRefPath(trimmedNeedle);
	const normalizedMessage = normalizeRefPath(message);
	return (
		normalizedMessage.includes(normalizedNeedle) ||
		normalizedMessage.endsWith(`/${normalizedNeedle}`)
	);
};

const POLICY_DENY_ASSERTION_PREFIX = "must_trigger_policy_deny:";
const MUST_READ_REF_ASSERTION_PREFIX = "must_read_ref:";
const MUST_NOT_READ_REF_ASSERTION_PREFIX = "must_not_read_ref:";
const MUST_READ_REFS_COUNT_AT_LEAST_ASSERTION_PREFIX = "must_read_refs_count_at_least:";
const MUST_READ_EXACT_REFS_ASSERTION_PREFIX = "must_read_exact_refs:";

const getExpectedPolicyDenyNeedles = (assertions: string[]): string[] =>
	assertions
		.filter((assertion) => assertion.startsWith(POLICY_DENY_ASSERTION_PREFIX))
		.map((assertion) => assertion.slice(POLICY_DENY_ASSERTION_PREFIX.length).trim());

const createFailureCollector = () => {
	const failures: FailureReason[] = [];
	const seen = new Set<string>();
	const pushFailure = (category: FailureCategory, message: string) => {
		const key = `${category}:${message}`;
		if (seen.has(key)) return;
		seen.add(key);
		failures.push({ category, message });
	};
	return { failures, pushFailure };
};

export const evaluateCase = async (
	evalCase: EvalCase,
	result: CaseRunResult,
	options: EvaluateCaseOptions = {},
): Promise<CaseEvaluation> => {
	const { failures, pushFailure } = createFailureCollector();
	const useAttempts = result.dryRun;
	const expectedPolicyDenyNeedles = getExpectedPolicyDenyNeedles(evalCase.assertions ?? []);
	const availableSkills = result.availableSkills ?? [];
	const attemptedSkills = uniqueSorted(result.skillAttempts ?? []);
	const successfulSkills = uniqueSorted(result.skillInvocations ?? []);
	const deniedSkills = uniqueSorted(result.skillDenied ?? []);
	const attemptedSkillFiles = uniqueSorted(result.skillFileAttempts ?? []);
	const successfulSkillFiles = uniqueSorted(result.skillFileInvocations ?? []);
	const deniedSkillFiles = uniqueSorted(result.skillFileDenied ?? []);
	const attemptedRefs = uniqueSorted((result.refAttempts ?? []).map(normalizeRefPath));
	const successfulRefs = uniqueSorted((result.refInvocations ?? []).map(normalizeRefPath));
	const deniedRefs = uniqueSorted((result.refDenied ?? []).map(normalizeRefPath));
	const invokedSkills = useAttempts ? attemptedSkills : successfulSkills;
	const invokedSkillFiles = useAttempts ? attemptedSkillFiles : successfulSkillFiles;
	const normalizedInvokedRefs = useAttempts ? attemptedRefs : successfulRefs;
	const expectedRefs = uniqueSorted((evalCase.expectedRefs ?? []).map(normalizeRefPath));

	const expectedProfile = evalCase.bootstrapProfile ?? (evalCase.disableHarness ? "no_payload" : "full_payload");
	if (!result.bootstrapProfile) {
		pushFailure("BOOTSTRAP_FAILURE", "missing bootstrap profile in worker result");
	} else if (result.bootstrapProfile !== expectedProfile) {
		pushFailure(
			"BOOTSTRAP_FAILURE",
			`bootstrap profile mismatch: expected ${expectedProfile}, got ${result.bootstrapProfile}`,
		);
	}

	const expectedManifestHash = options.expectedBootstrapManifestHash ?? null;
	if (expectedManifestHash && !result.bootstrapManifestHash) {
		pushFailure("BOOTSTRAP_FAILURE", "missing bootstrap manifest hash in worker result");
	}
	if (
		expectedManifestHash &&
		result.bootstrapManifestHash &&
		result.bootstrapManifestHash !== expectedManifestHash
	) {
		pushFailure(
			"BOOTSTRAP_FAILURE",
			`bootstrap manifest hash mismatch: expected ${expectedManifestHash}, got ${result.bootstrapManifestHash}`,
		);
	}
	if (result.bootstrapProfile && result.bootstrapManifestHash) {
		const computedHash = buildManifestHash({
			caseId: evalCase.id,
			profile: result.bootstrapProfile,
			availableSkills,
		});
		if (computedHash !== result.bootstrapManifestHash) {
			pushFailure(
				"BOOTSTRAP_FAILURE",
				`bootstrap manifest integrity mismatch: expected ${computedHash}, got ${result.bootstrapManifestHash}`,
			);
		}
	}
	if (expectedProfile === "no_payload" && availableSkills.length > 0) {
		pushFailure(
			"BOOTSTRAP_FAILURE",
			`no_payload profile exposed ${availableSkills.length} bootstrap skill(s)`,
		);
	}

	const missingBootstrapSkills = uniqueSorted(
		(evalCase.expectedSkills ?? []).filter((skill) => !availableSkills.includes(skill)),
	);
	if (missingBootstrapSkills.length > 0) {
		pushFailure(
			"BOOTSTRAP_FAILURE",
			`missing bootstrap skills: ${formatList(missingBootstrapSkills)}; available bootstrap skills: ${formatList(availableSkills)}`,
		);
	}

	const missingSkillFileReads = evalCase.requireSkillFileRead
		? uniqueSorted(
			(evalCase.expectedSkills ?? []).filter((skill) => !invokedSkillFiles.includes(skill)),
		)
		: [];
	if (missingSkillFileReads.length > 0) {
		pushFailure(
			"ROUTING_FAILURE",
			`missing skill-file reads: ${formatList(missingSkillFileReads)}; read skill files: ${formatList(invokedSkillFiles)}`,
		);
	}

	for (const skill of evalCase.disallowedSkills ?? []) {
		if (expectedProfile === "no_payload" && availableSkills.includes(skill)) {
			pushFailure("BOOTSTRAP_FAILURE", `unexpected bootstrap skill: ${skill}`);
		}
		if (invokedSkills.includes(skill)) {
			const category: FailureCategory = expectedProfile === "no_payload"
				? "POLICY_FAILURE"
				: "ROUTING_FAILURE";
			pushFailure(category, `unexpected skill read: ${skill}`);
		}
	}

	const missingRefs = expectedRefs.filter(
		(expectedRef) => !isExpectedRefRead(expectedRef, normalizedInvokedRefs),
	);
	if (missingRefs.length > 0) {
		pushFailure(
			"ROUTING_FAILURE",
			`missing refs: ${formatList(missingRefs)}; read refs: ${formatList(normalizedInvokedRefs)}`,
		);
	}
	const unexpectedRefs = expectedRefs.length === 0
		? []
		: normalizedInvokedRefs.filter(
			(observedRef) => !expectedRefs.some((expectedRef) => isRefMatch(observedRef, expectedRef)),
		);

	const fileAssertions = evalCase.fileAssertions ?? [];
	if (fileAssertions.length > 0) {
		if (!result.workspaceDir) {
			pushFailure("TASK_FAILURE", "missing workspace for file assertions");
		} else {
			for (const assertion of fileAssertions) {
				const targetPath = path.join(result.workspaceDir, assertion.path);
				let content = "";
				try {
					content = await readFile(targetPath, "utf-8");
				} catch {
					pushFailure("TASK_FAILURE", `missing file: ${assertion.path}`);
					continue;
				}
				for (const needle of assertion.mustContain ?? []) {
					if (!content.includes(needle)) {
						pushFailure("TASK_FAILURE", `file assertion failed: ${assertion.path} missing ${needle}`);
					}
				}
				for (const needle of assertion.mustNotContain ?? []) {
					if (content.includes(needle)) {
						pushFailure("TASK_FAILURE", `file assertion failed: ${assertion.path} contains ${needle}`);
					}
				}
				if (
					typeof assertion.maxNonEmptyLines === "number" &&
					Number.isFinite(assertion.maxNonEmptyLines)
				) {
					const nonEmptyLines = content
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line.length > 0).length;
					if (nonEmptyLines > assertion.maxNonEmptyLines) {
						pushFailure(
							"TASK_FAILURE",
							`file assertion failed: ${assertion.path} has ${nonEmptyLines} non-empty lines (max ${assertion.maxNonEmptyLines})`,
						);
					}
				}
			}
		}
	}

	const outputText = result.outputText ?? "";
	for (const assertion of evalCase.assertions ?? []) {
		if (assertion.startsWith("must_trigger_policy_deny:")) {
			const needle = assertion.slice("must_trigger_policy_deny:".length).trim();
			const hasPolicyDeny = result.errors.some(
				(error) => isPolicyFailure(error) && isPathNeedleMatch(error, needle),
			);
			if (!hasPolicyDeny) {
				pushFailure("POLICY_FAILURE", `assertion failed: ${assertion}`);
			}
			continue;
		}
		if (assertion.startsWith(MUST_READ_REF_ASSERTION_PREFIX)) {
			const needle = normalizeRefPath(assertion.slice(MUST_READ_REF_ASSERTION_PREFIX.length));
			if (!isExpectedRefRead(needle, normalizedInvokedRefs)) {
				pushFailure(
					"ROUTING_FAILURE",
					`assertion failed: ${assertion}; read refs: ${formatList(normalizedInvokedRefs)}`,
				);
			}
			continue;
		}
		if (assertion.startsWith(MUST_NOT_READ_REF_ASSERTION_PREFIX)) {
			const needle = normalizeRefPath(assertion.slice(MUST_NOT_READ_REF_ASSERTION_PREFIX.length));
			if (isExpectedRefRead(needle, normalizedInvokedRefs)) {
				pushFailure(
					"ROUTING_FAILURE",
					`assertion failed: ${assertion}; read refs: ${formatList(normalizedInvokedRefs)}`,
				);
			}
			continue;
		}
		if (assertion.startsWith(MUST_READ_REFS_COUNT_AT_LEAST_ASSERTION_PREFIX)) {
			const rawThreshold = assertion
				.slice(MUST_READ_REFS_COUNT_AT_LEAST_ASSERTION_PREFIX.length)
				.trim();
			const threshold = Number.parseInt(rawThreshold, 10);
			if (!Number.isFinite(threshold)) {
				pushFailure("TASK_FAILURE", `assertion failed: ${assertion}`);
				continue;
			}
			if (normalizedInvokedRefs.length < threshold) {
				pushFailure(
					"ROUTING_FAILURE",
					`assertion failed: ${assertion}; read refs count=${normalizedInvokedRefs.length}`,
				);
			}
			continue;
		}
		if (assertion.startsWith(MUST_READ_EXACT_REFS_ASSERTION_PREFIX)) {
			const expectedExactRefs = uniqueSorted(
				assertion
					.slice(MUST_READ_EXACT_REFS_ASSERTION_PREFIX.length)
					.split(",")
					.map((item) => normalizeRefPath(item)),
			);
			const exactMissingRefs = expectedExactRefs.filter(
				(expectedRef) => !isExpectedRefRead(expectedRef, normalizedInvokedRefs),
			);
			const exactUnexpectedRefs = normalizedInvokedRefs.filter(
				(observedRef) => !expectedExactRefs.some((expectedRef) => isRefMatch(observedRef, expectedRef)),
			);
			if (exactMissingRefs.length > 0 || exactUnexpectedRefs.length > 0) {
				pushFailure(
					"ROUTING_FAILURE",
					`assertion failed: ${assertion}; missing refs: ${formatList(exactMissingRefs)}; unexpected refs: ${formatList(exactUnexpectedRefs)}`,
				);
			}
			continue;
		}
		if (assertion.startsWith("must_contain:")) {
			const needle = assertion.slice("must_contain:".length);
			if (!outputText.includes(needle)) pushFailure("TASK_FAILURE", `assertion failed: ${assertion}`);
			continue;
		}
		if (assertion.startsWith("must_not_contain:")) {
			const needle = assertion.slice("must_not_contain:".length);
			if (outputText.includes(needle)) pushFailure("TASK_FAILURE", `assertion failed: ${assertion}`);
			continue;
		}
		pushFailure("TASK_FAILURE", `unknown assertion: ${assertion}`);
	}

	const budget = evalCase.tokenBudget ?? null;
	if (budget !== null && result.tokens.totalTokens > budget) {
		pushFailure("TASK_FAILURE", `token budget exceeded (${result.tokens.totalTokens} > ${budget})`);
	}

	for (const error of result.errors ?? []) {
		if (isPolicyFailure(error)) {
			const isExpectedPolicyDeny = expectedPolicyDenyNeedles.some((needle) =>
				isPathNeedleMatch(error, needle)
			);
			if (isExpectedPolicyDeny) continue;
			pushFailure("POLICY_FAILURE", `run error: ${error}`);
			continue;
		}
		if (/missing bootstrap skill/i.test(error) || /bootstrap/i.test(error)) {
			pushFailure("BOOTSTRAP_FAILURE", `run error: ${error}`);
			continue;
		}
		pushFailure("TASK_FAILURE", `run error: ${error}`);
	}

	return buildCaseResult(evalCase.id, result, evalCase, failures, {
		readSkills: invokedSkills,
		readSkillFiles: invokedSkillFiles,
		readRefs: normalizedInvokedRefs,
		attemptedSkills,
		successfulSkills,
		deniedSkills,
		attemptedSkillFiles,
		successfulSkillFiles,
		deniedSkillFiles,
		attemptedRefs,
		successfulRefs,
		deniedRefs,
		missingSkillFileReads,
		missingRefs,
		unexpectedRefs: uniqueSorted(unexpectedRefs),
	});
};
