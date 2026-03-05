import assert from "node:assert/strict";
import test from "node:test";
import type {
	CaseEvaluation,
	CaseRunResult,
	JudgeBundleVerdict,
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

const buildVerdict = (overrides: Partial<JudgeBundleVerdict> = {}): JudgeBundleVerdict => ({
	bundleId: "CD-TEST",
	variantTags: ["skill", "noskill"],
	pass: true,
	verdict: "Skill knowledge helped",
	dimensions: [],
	variantVerdicts: [
		{ tag: "skill", pass: true, rationale: "Clear improvement" },
		{ tag: "noskill", pass: true, rationale: "Baseline works" },
	],
	costAnalysis: "",
	recommendation: "",
	rawResponse: "{}",
	judgeTokens: zeroTokens,
	...overrides,
});

test("applyJudgeVerdicts sets pass status from judge", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdicts = new Map([["CD-TEST", buildVerdict()]]);

	applyJudgeVerdicts(evaluations, verdicts, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[1].status, "pass");
	assert.deepEqual(evaluations[0].failureReasons, []);
});

test("applyJudgeVerdicts sets fail status when judge fails a variant", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdicts = new Map([
		["CD-TEST", buildVerdict({
			pass: false,
			verdict: "No benefit from skills",
			variantVerdicts: [
				{ tag: "skill", pass: false, rationale: "Equivalent to baseline" },
				{ tag: "noskill", pass: true, rationale: "Baseline works fine" },
			],
		})],
	]);

	applyJudgeVerdicts(evaluations, verdicts, cases);

	assert.equal(evaluations[0].status, "fail");
	assert.equal(evaluations[0].reasons[0], "JUDGE: Equivalent to baseline");
	assert.equal(evaluations[0].failureReasons[0].category, "TASK_FAILURE");
	assert.equal(evaluations[1].status, "pass");
});

test("applyJudgeVerdicts attaches verdict to evaluations", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
		buildEvalCase({ id: "CD-TEST:noskill", variantTag: "noskill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill"), buildEvaluation("CD-TEST:noskill")];
	const verdict = buildVerdict();
	const verdicts = new Map([["CD-TEST", verdict]]);

	applyJudgeVerdicts(evaluations, verdicts, cases);

	assert.equal(evaluations[0].judgeVerdict, verdict);
	assert.equal(evaluations[1].judgeVerdict, verdict);
});

test("applyJudgeVerdicts skips standalone cases without bundles", () => {
	const cases = [
		buildEvalCase({ id: "CD-STANDALONE", bundleId: null, variantTag: null }),
	];
	const evaluations = [buildEvaluation("CD-STANDALONE")];
	const verdicts = new Map<string, JudgeBundleVerdict>();

	applyJudgeVerdicts(evaluations, verdicts, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[0].judgeVerdict, undefined);
});

test("applyJudgeVerdicts handles missing verdict for bundle gracefully", () => {
	const cases = [
		buildEvalCase({ id: "CD-TEST:skill", variantTag: "skill" }),
	];
	const evaluations = [buildEvaluation("CD-TEST:skill")];
	const verdicts = new Map<string, JudgeBundleVerdict>();

	applyJudgeVerdicts(evaluations, verdicts, cases);

	assert.equal(evaluations[0].status, "pass");
	assert.equal(evaluations[0].judgeVerdict, undefined);
});
