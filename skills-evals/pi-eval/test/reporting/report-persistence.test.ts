import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CaseEvaluation, EvalCase, EvalRunOptions, ModelSpec } from "../../src/data/types.js";
import { fileExists } from "../../src/data/utils.js";
import { persistRunReport } from "../../src/reporting/report-persistence.js";

const TEST_MODEL: ModelSpec = {
	provider: "openai",
	id: "gpt-5",
	key: "openai/gpt-5",
	label: "openai/gpt-5",
};

const buildOptions = (agentDir: string, isFullRun: boolean): EvalRunOptions => ({
	agentDir,
	model: TEST_MODEL,
	casesPath: path.join(agentDir, "skills-evals", "fixtures", "cases.jsonl"),
	defaultCasesPath: path.join(agentDir, "skills-evals", "fixtures", "cases.jsonl"),
	filter: undefined,
	limitOverride: undefined,
	dryRunOverride: false,
	thinkingLevel: "low",
	caseParallelism: 1,
	evalAuthSource: null,
	isFullRun,
	casesPathLabel: "skills-evals/fixtures/cases.jsonl",
});

const buildEvalCase = (id: string): EvalCase => ({
	id,
	suite: "pi-eval",
	prompt: "prompt",
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
});

const buildEvaluation = (caseId: string, status: "pass" | "fail"): CaseEvaluation => ({
	caseId,
	suite: "pi-eval",
	mode: "single",
	status,
	reasons: status === "pass" ? [] : ["TASK_FAILURE: failed"],
	failureReasons: status === "pass" ? [] : [{ category: "TASK_FAILURE", message: "failed" }],
	result: {
		caseId,
		dryRun: false,
		model: null,
		skillInvocations: ["coding"],
		skillAttempts: ["coding"],
		skillFileInvocations: ["coding"],
		skillFileAttempts: ["coding"],
		refInvocations: ["skills/coding/references/index.md"],
		refAttempts: ["skills/coding/references/index.md"],
		outputText: "done",
		tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		durationMs: 10,
		errors: [],
	},
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	routing: {
		readSkills: ["coding"],
		readSkillFiles: ["coding"],
		readRefs: ["skills/coding/references/index.md"],
		missingSkillFileReads: [],
		missingRefs: [],
		unexpectedRefs: [],
	},
	assertions: [],
	tokenBudget: null,
});

test("persistRunReport merges with previous report rows and updates index on full runs", async () => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-report-full-"));
	try {
		const options = buildOptions(agentDir, true);
		const defaultCases = [buildEvalCase("CD-OLD"), buildEvalCase("../../CD-TRACE")];
		const reportRoot = path.join(agentDir, "skills-evals", "reports");
		const reportPath = path.join(reportRoot, "openai-gpt-5.md");
		await mkdir(reportRoot, { recursive: true });
		await writeFile(
			reportPath,
			[
				"# Pi Eval Report",
				"",
				"| Case | Mode | Status | Tokens | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |",
				"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
				"| CD-OLD | single | FAIL | 5 | 1 | 1 | 1 | - | - | previous fail | 2026-02-20 |",
				"",
			].join("\n"),
			"utf-8",
		);

		const { indexPath } = await persistRunReport({
			options,
			defaultCases,
			evaluations: [buildEvaluation("../../CD-TRACE", "pass")],
			durationMs: 500,
		});

		const reportContent = await readFile(reportPath, "utf-8");
		assert.equal(reportContent.includes("| CD-OLD | single | FAIL |"), true);
		assert.equal(reportContent.includes("| ../../CD-TRACE | single | PASS |"), true);

		assert.equal(await fileExists(indexPath), true);
		const indexContent = await readFile(indexPath, "utf-8");
		const parsedIndex = JSON.parse(indexContent) as Record<string, { sha: string; timestamp: string }>;
		assert.equal(Boolean(parsedIndex[options.model.key]), true);

		const routingTracePath = path.join(
			reportRoot,
			"routing-traces",
			"openai-gpt-5",
			"CD-TRACE.json",
		);
		assert.equal(await fileExists(routingTracePath), true);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("persistRunReport skips index updates on partial runs", async () => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-report-partial-"));
	try {
		const options = buildOptions(agentDir, false);
		const defaultCases = [buildEvalCase("CD-001")];

		const { reportPath, indexPath } = await persistRunReport({
			options,
			defaultCases,
			evaluations: [buildEvaluation("CD-001", "pass")],
			durationMs: 200,
		});

		assert.equal(await fileExists(reportPath), true);
		assert.equal(await fileExists(indexPath), false);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
