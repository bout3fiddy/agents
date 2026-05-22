import assert from "node:assert/strict";
import test from "node:test";
import type {
	CaseEvaluation,
	JudgeSuiteVerdict,
	ResolvedEvalCase,
	TokenUsage,
} from "../../src/data/types.js";
import { applyJudgeVerdicts } from "../../src/judging/judge.js";

const zeroTokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

const buildEvalCase = (overrides: Partial<ResolvedEvalCase> = {}): ResolvedEvalCase => ({
	id: "CD-TEST:skill",
	suite: "test",
	prompt: "test prompt",
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	bundleId: "CD-TEST",
	variantTag: "skill",
	...overrides,
});

const buildEvaluation = (caseId: string): CaseEvaluation => ({
	caseId,
	suite: "test",
	mode: "single",
	status: "pass",
	reasons: [],
	failureReasons: [],
	result: {
		caseId,
		dryRun: false,
		model: null,
		skillInvocations: [],
		skillAttempts: [],
		refInvocations: [],
		refAttempts: [],
		outputText: "",
		tokens: zeroTokens,
		durationMs: 0,
		errors: [],
	},
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	routing: {
		readSkills: [],
		readSkillFiles: [],
		readRefs: [],
		missingSkillFileReads: [],
		missingRefs: [],
		unexpectedRefs: [],
	},
	assertions: [],
});

const buildVerdict = (overrides: Partial<JudgeSuiteVerdict> = {}): JudgeSuiteVerdict => ({
	pass: true,
	reportMarkdown: "## Executive Summary\nSkill knowledge helped.",
	cases: [{
		caseId: "CD-TEST",
		bundlePass: true,
		skillBenefit: "clear",
		variants: [
			{ tag: "skill", taskPass: true, rationale: "Clear improvement" },
			{ tag: "noskill", taskPass: true, rationale: "Baseline works" },
		],
		decisiveEvidence: [{
			kind: "verification",
			claim: "both variants completed",
			source: "verification-output.md",
		}],
		skillFeedback: ["Skill guidance helped on the measured boundary."],
	}],
	skillFeedback: ["Keep benchmark guidance concrete."],
	rawResponse: "{}",
	judgeTokens: zeroTokens,
	...overrides,
});

test("applyJudgeVerdicts preserves task status when judge passes variants", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdict = buildVerdict();

	applyJudgeVerdicts(evaluations, verdict, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[1].status, "pass");
	assert.deepEqual(evaluations[0].failureReasons, []);
});

test("applyJudgeVerdicts does not turn a no-clear-win comparison into a task failure", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdict = buildVerdict({
		pass: false,
		cases: [{
			caseId: "CD-TEST",
			bundlePass: false,
			skillBenefit: "none",
			variants: [
				{ tag: "skill", taskPass: true, rationale: "Equivalent to baseline" },
				{ tag: "noskill", taskPass: true, rationale: "Baseline works fine" },
			],
			decisiveEvidence: [{
				kind: "code-fact",
				claim: "outputs are equivalent",
				source: "cases/CD-TEST",
			}],
			skillFeedback: ["The skill did not change the final output."],
		}],
	});

	applyJudgeVerdicts(evaluations, verdict, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.deepEqual(evaluations[0].reasons, []);
	assert.equal(evaluations[1].status, "pass");
	assert.equal(evaluations[0].judgeVerdict?.skillBenefit, "none");
});

test("applyJudgeVerdicts preserves existing failures when judge marks variant pass", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
	];
	const failedEvaluation = buildEvaluation("CD-TEST:skill");
	failedEvaluation.status = "fail";
	failedEvaluation.reasons = ["TASK_FAILURE: verification failed"];
	failedEvaluation.failureReasons = [{
		category: "TASK_FAILURE",
		message: "verification failed",
	}];
	const verdict = buildVerdict({
		cases: [{
			caseId: "CD-TEST",
			bundlePass: true,
			skillBenefit: "clear",
			variants: [
				{ tag: "skill", taskPass: true, rationale: "Looks fine" },
			],
			decisiveEvidence: [{
				kind: "verification",
				claim: "verification passed",
				source: "verification-output.md",
			}],
			skillFeedback: [],
		}],
	});

	applyJudgeVerdicts([failedEvaluation], verdict, cases);

	assert.equal(failedEvaluation.status, "fail");
	assert.equal(failedEvaluation.failureReasons[0].message, "verification failed");
});

test("applyJudgeVerdicts attaches verdict to evaluations", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdict = buildVerdict();

	applyJudgeVerdicts(evaluations, verdict, cases);

	assert.equal(evaluations[0].judgeVerdict, verdict.cases[0]);
	assert.equal(evaluations[1].judgeVerdict, verdict.cases[0]);
	assert.equal(evaluations[0].judgeSuiteVerdict, verdict);
	assert.equal(evaluations[1].judgeSuiteVerdict, verdict);
});

test("applyJudgeVerdicts leaves standalone cases alone when no judge ran", () => {
	const cases = [
		buildEvalCase({ id: "CD-STANDALONE", bundleId: null, variantTag: null }),
	];
	const evaluations = [buildEvaluation("CD-STANDALONE")];

	applyJudgeVerdicts(evaluations, null, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[0].judgeVerdict, undefined);
});

test("applyJudgeVerdicts attaches standalone verdicts without overwriting task status", () => {
	const cases = [
		buildEvalCase({ id: "CD-STANDALONE", bundleId: null, variantTag: null }),
	];
	const evaluations = [buildEvaluation("CD-STANDALONE")];
	const verdict = buildVerdict({
		cases: [{
			caseId: "CD-STANDALONE",
			bundlePass: false,
			skillBenefit: "inconclusive",
			variants: [
				{ tag: "single", taskPass: false, rationale: "black-box verification failed" },
			],
			decisiveEvidence: [{
				kind: "verification",
				claim: "verification exited 1",
				source: "cases/CD-STANDALONE/single/verification-output.md",
			}],
			skillFeedback: [],
		}],
	});

	applyJudgeVerdicts(evaluations, verdict, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[0].judgeVerdict, verdict.cases[0]);
	assert.deepEqual(evaluations[0].reasons, []);
});

test("applyJudgeVerdicts leaves task status alone when suite verdict omits a bundle", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill")];
	const verdict = buildVerdict({ cases: [] });

	applyJudgeVerdicts(evaluations, verdict, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[0].judgeVerdict, undefined);
	assert.equal(evaluations[0].judgeSuiteVerdict, verdict);
});
