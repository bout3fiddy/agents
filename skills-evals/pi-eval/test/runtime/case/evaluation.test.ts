import assert from "node:assert/strict";
import test from "node:test";
import type { CaseRunResult, EvalCase } from "../../../src/data/types.js";
import { assembleEvaluation, buildCaseResult } from "../../../src/runtime/case/evaluation.js";

const buildEvalCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
	id: "CD-SCORE-001",
	suite: "pi-eval",
	prompt: "Evaluate scoring flow",
	expectedSkills: ["coding"],
	disallowedSkills: [],
	expectedRefs: ["skills/coding/references/index.md"],
	requireSkillFileRead: true,
	assertions: [],
	bootstrapProfile: "full_payload",
	...overrides,
});

const buildResult = (evalCase: EvalCase, overrides: Partial<CaseRunResult> = {}): CaseRunResult => ({
	caseId: evalCase.id,
	dryRun: false,
	model: null,
	skillInvocations: ["coding"],
	skillAttempts: ["coding"],
	skillFileInvocations: ["coding"],
	skillFileAttempts: ["coding"],
	refInvocations: ["skills/coding/references/index.md"],
	refAttempts: ["skills/coding/references/index.md"],
	outputText: "done",
	tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
	durationMs: 100,
	errors: [],
	availableSkills: ["coding"],
	bootstrapProfile: "full_payload",
	workspaceDir: null,
	...overrides,
});

test("assembleEvaluation returns pass status (judge decides)", () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase);
	const evaluation = assembleEvaluation(evalCase, result);

	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.failureReasons, []);
});

test("assembleEvaluation populates routing scorecard from result", () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase);
	const evaluation = assembleEvaluation(evalCase, result);

	assert.deepEqual(evaluation.routing.readSkills, ["coding"]);
	assert.deepEqual(evaluation.routing.readSkillFiles, ["coding"]);
	assert.deepEqual(evaluation.routing.readRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.attemptedRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.successfulRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.deniedRefs, []);
});

test("assembleEvaluation uses attempts in dry-run mode", () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase, {
		dryRun: true,
		skillInvocations: [],
		skillFileInvocations: [],
		refInvocations: [],
		skillAttempts: ["coding"],
		skillFileAttempts: ["coding"],
		refAttempts: ["skills/coding/references/index.md"],
	});

	const evaluation = assembleEvaluation(evalCase, result);

	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.routing.readSkills, ["coding"]);
	assert.deepEqual(evaluation.routing.readSkillFiles, ["coding"]);
	assert.deepEqual(evaluation.routing.readRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.attemptedRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.successfulRefs, []);
});

test("assembleEvaluation preserves errors without failing", () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase, {
		errors: [
			"forbidden read: /tmp/work/skills/private/SKILL.md",
			"non-policy error",
		],
	});

	const evaluation = assembleEvaluation(evalCase, result);

	// Errors preserved in result but do not cause failure
	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.failureReasons, []);
	assert.equal(evaluation.result.errors.length, 2);
});

test("assembleEvaluation preserves case metadata", () => {
	const evalCase = buildEvalCase({
		expectedSkills: ["coding"],
		expectedRefs: ["skills/coding/references/index.md"],
		disallowedSkills: ["design"],
	});
	const result = buildResult(evalCase);
	const evaluation = assembleEvaluation(evalCase, result);

	assert.deepEqual(evaluation.expectedSkills, ["coding"]);
	assert.deepEqual(evaluation.expectedRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.disallowedSkills, ["design"]);
	assert.equal(evaluation.suite, "pi-eval");
	assert.equal(evaluation.caseId, "CD-SCORE-001");
});

test("buildCaseResult with failures produces fail status", () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase);
	const evaluation = buildCaseResult(
		evalCase.id,
		result,
		evalCase,
		[{ category: "TASK_FAILURE", message: "something broke" }],
	);

	assert.equal(evaluation.status, "fail");
	assert.equal(evaluation.failureReasons.length, 1);
	assert.equal(evaluation.failureReasons[0].message, "something broke");
});

test("assembleEvaluation handles empty routing data", () => {
	const evalCase = buildEvalCase({ expectedSkills: [], expectedRefs: [] });
	const result = buildResult(evalCase, {
		skillInvocations: [],
		skillAttempts: [],
		skillFileInvocations: [],
		skillFileAttempts: [],
		refInvocations: [],
		refAttempts: [],
	});

	const evaluation = assembleEvaluation(evalCase, result);

	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.routing.readSkills, []);
	assert.deepEqual(evaluation.routing.readRefs, []);
});
