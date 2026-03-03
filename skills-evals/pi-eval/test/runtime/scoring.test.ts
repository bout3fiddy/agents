import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BootstrapProfile, CaseRunResult, EvalCase } from "../../src/data/types.js";
import { evaluateCase } from "../../src/runtime/scoring.js";

const buildManifestHash = (
	caseId: string,
	profile: BootstrapProfile,
	availableSkills: string[],
): string => {
	const payload = JSON.stringify({
		caseId,
		profile,
		availableSkills: [...availableSkills].sort(),
	});
	return createHash("sha256").update(payload).digest("hex");
};

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

const buildResult = (evalCase: EvalCase, overrides: Partial<CaseRunResult> = {}): CaseRunResult => {
	const availableSkills = overrides.availableSkills ?? ["coding"];
	const bootstrapProfile = overrides.bootstrapProfile ?? "full_payload";
	return {
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
		availableSkills,
		bootstrapProfile,
		bootstrapManifestHash: buildManifestHash(evalCase.id, bootstrapProfile, availableSkills),
		workspaceDir: null,
		...overrides,
	};
};

test("evaluateCase passes when routing and bootstrap signals match", async () => {
	const evalCase = buildEvalCase();
	const result = buildResult(evalCase);
	const evaluation = await evaluateCase(
		evalCase,
		result,
		{ expectedBootstrapManifestHash: result.bootstrapManifestHash },
	);

	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.failureReasons, []);
	assert.deepEqual(evaluation.routing.missingRefs, []);
	assert.deepEqual(evaluation.routing.missingSkillFileReads, []);
	assert.deepEqual(evaluation.routing.attemptedRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.successfulRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.deniedRefs, []);
});

test("evaluateCase uses attempts in dry-run mode", async () => {
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

	const evaluation = await evaluateCase(
		evalCase,
		result,
		{ expectedBootstrapManifestHash: result.bootstrapManifestHash },
	);

	assert.equal(evaluation.status, "pass");
	assert.deepEqual(evaluation.routing.readSkills, ["coding"]);
	assert.deepEqual(evaluation.routing.readSkillFiles, ["coding"]);
	assert.deepEqual(evaluation.routing.readRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.attemptedRefs, ["skills/coding/references/index.md"]);
	assert.deepEqual(evaluation.routing.successfulRefs, []);
});

test("evaluateCase categorizes policy, bootstrap, and task errors", async () => {
	const evalCase = buildEvalCase({
		assertions: ["must_trigger_policy_deny:skills/private/SKILL.md"],
		expectedRefs: [],
		requireSkillFileRead: false,
	});
	const result = buildResult(evalCase, {
		refInvocations: [],
		refAttempts: [],
		errors: [
			"forbidden read: /tmp/work/skills/private/SKILL.md",
			"FORBIDDEN_WORKSPACE_VIOLATION: /tmp/work/../escape",
			"bootstrap setup failed",
			"non-policy error",
		],
	});

	const evaluation = await evaluateCase(evalCase, result, {
		expectedBootstrapManifestHash: result.bootstrapManifestHash,
	});
	const categories = new Set(evaluation.failureReasons.map((item) => item.category));

	assert.equal(evaluation.status, "fail");
	assert.equal(categories.has("POLICY_FAILURE"), true);
	assert.equal(categories.has("BOOTSTRAP_FAILURE"), true);
	assert.equal(categories.has("TASK_FAILURE"), true);
	assert.equal(
		evaluation.failureReasons.some((item) =>
			item.message.includes("assertion failed: must_trigger_policy_deny:")
		),
		false,
	);
});

test("evaluateCase fails must_trigger_policy_deny when deny signal is missing", async () => {
	const evalCase = buildEvalCase({
		assertions: ["must_trigger_policy_deny:skills/private/SKILL.md"],
		expectedRefs: [],
		requireSkillFileRead: false,
	});
	const result = buildResult(evalCase, {
		refInvocations: [],
		refAttempts: [],
		errors: ["policy deny missing: /tmp/work/skills/private/SKILL.md"],
	});

	const evaluation = await evaluateCase(evalCase, result, {
		expectedBootstrapManifestHash: result.bootstrapManifestHash,
	});

	assert.equal(evaluation.status, "fail");
	assert.equal(
		evaluation.failureReasons.some((item) =>
			item.message.includes("assertion failed: must_trigger_policy_deny:skills/private/SKILL.md")
		),
		true,
	);
});

test("evaluateCase enforces file assertions and token budgets", async () => {
	const workspaceDir = await mkdtemp(path.join(tmpdir(), "pi-eval-scoring-"));
	try {
		const targetFile = path.join(workspaceDir, "artifact.txt");
		await writeFile(targetFile, "line-1\nline-2\nline-3\n", "utf-8");
		const evalCase = buildEvalCase({
			expectedRefs: [],
			requireSkillFileRead: false,
			fileAssertions: [
				{
					path: "artifact.txt",
					mustContain: ["line-1", "missing-line"],
					mustNotContain: ["line-2"],
					maxNonEmptyLines: 2,
				},
			],
			tokenBudget: 1,
		});
		const result = buildResult(evalCase, {
			refInvocations: [],
			refAttempts: [],
			workspaceDir,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
		});

		const evaluation = await evaluateCase(evalCase, result, {
			expectedBootstrapManifestHash: result.bootstrapManifestHash,
		});
		const messages = evaluation.failureReasons.map((item) => item.message);

		assert.equal(evaluation.status, "fail");
		assert.equal(messages.some((message) => message.includes("artifact.txt missing missing-line")), true);
		assert.equal(messages.some((message) => message.includes("artifact.txt contains line-2")), true);
		assert.equal(messages.some((message) => message.includes("has 3 non-empty lines")), true);
		assert.equal(messages.some((message) => message.includes("token budget exceeded")), true);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});

test("evaluateCase enforces exact-ref assertions", async () => {
	const evalCase = buildEvalCase({
		expectedRefs: [],
		requireSkillFileRead: false,
		assertions: ["must_read_exact_refs:skills/a.md,skills/b.md"],
	});
	const result = buildResult(evalCase, {
		refInvocations: ["skills/a.md", "skills/c.md"],
		refAttempts: ["skills/a.md", "skills/c.md"],
	});

	const evaluation = await evaluateCase(evalCase, result, {
		expectedBootstrapManifestHash: result.bootstrapManifestHash,
	});

	assert.equal(evaluation.status, "fail");
	assert.equal(
		evaluation.failureReasons.some((item) =>
			item.message.includes("must_read_exact_refs:skills/a.md,skills/b.md")
		),
		true,
	);
});
