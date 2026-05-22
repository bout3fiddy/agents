import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	apiCostFromTokens,
	type CaseEvaluation,
	type EvalBundle,
	type EvalRunOptions,
	type JudgeCaseVerdict,
	type JudgeEvidenceItem,
	type JudgeEvidenceKind,
	type JudgeSkillBenefit,
	type JudgeSuiteVerdict,
	type JudgeVariantVerdict,
	type ModelSpec,
	type ResolvedEvalCase,
	type TokenUsage,
	type VerificationResult,
} from "../data/types.js";
import { errorMessage } from "../data/utils.js";
import { createMandatorySandboxEngine, type SandboxedProcessHandle } from "../runtime/engine/sandbox-engine.js";
import { resolveInsideRoot, toSafePathSegment } from "../runtime/policy/path-policy.js";
import { collectAssistantText, sumUsageFromMessages } from "../runtime/rpc/rpc-messages.js";
import { cleanupJudgeSandbox, createJudgeSandbox, type JudgeSandboxLayout } from "./judge-sandbox.js";

type JudgeVariantInput = {
	tag: string;
	safeTag: string;
	files: Record<string, string>;
	output: string;
	stepTrace: string[];
	verification: string;
	verificationSummary: string;
	tokens: TokenUsage;
	toolSummary: string;
	routingTrace: string;
	errors: string[];
};

type JudgeCaseInput = {
	caseId: string;
	safeCaseId: string;
	prompt: string;
	notes: string;
	variants: JudgeVariantInput[];
};

type JudgeSuiteInput = {
	cases: JudgeCaseInput[];
};

type JudgeResponseSchema = {
	pass: boolean;
	reportMarkdown: string;
	skillFeedback?: string[];
	cases: Array<{
		caseId: string;
		bundlePass: boolean;
		skillBenefit: string;
		skillFeedback?: string[];
		variants: Array<{
			tag: string;
			taskPass?: boolean;
			pass?: boolean;
			rationale: string;
		}>;
		decisiveEvidence?: Array<{
			kind: string;
			claim: string;
			source: string;
		}>;
	}>;
};

const JUDGE_TIMEOUT_MS = 900_000;

const VALID_SKILL_BENEFITS = new Set<JudgeSkillBenefit>([
	"clear",
	"none",
	"worse",
	"inconclusive",
]);

const VALID_EVIDENCE_KINDS = new Set<JudgeEvidenceKind>([
	"verification",
	"correctness",
	"performance",
	"routing",
	"process",
	"code-fact",
	"inconclusive",
]);

const normalizeSkillBenefit = (value: unknown): JudgeSkillBenefit => {
	const normalized = String(value ?? "").trim().toLowerCase();
	return VALID_SKILL_BENEFITS.has(normalized as JudgeSkillBenefit)
		? normalized as JudgeSkillBenefit
		: "inconclusive";
};

const normalizeEvidenceKind = (value: unknown): JudgeEvidenceKind => {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (normalized === "code") return "code-fact";
	return VALID_EVIDENCE_KINDS.has(normalized as JudgeEvidenceKind)
		? normalized as JudgeEvidenceKind
		: "inconclusive";
};

const formatRoutingTrace = (evaluation: CaseEvaluation): string => {
	const r = evaluation.routing;
	const profile = evaluation.result.bootstrapProfile ?? "unknown";
	const available = evaluation.result.availableSkills ?? [];
	const lines = [
		`Bootstrap profile: ${profile}`,
		`Available skills: ${available.length > 0 ? available.join(", ") : "(none)"}`,
		`Skills read: ${r.readSkills.length > 0 ? r.readSkills.join(", ") : "(none)"}`,
		`Skill files read: ${r.readSkillFiles.length > 0 ? r.readSkillFiles.join(", ") : "(none)"}`,
		`Refs read: ${r.readRefs.length > 0 ? r.readRefs.join(", ") : "(none)"}`,
		`Refs attempted: ${(r.attemptedRefs ?? []).length > 0 ? (r.attemptedRefs ?? []).join(", ") : "(none)"}`,
	];
	if (evaluation.expectedSkills.length > 0) {
		lines.push(`Expected skills: ${evaluation.expectedSkills.join(", ")}`);
	}
	if (evaluation.expectedRefs.length > 0) {
		lines.push(`Expected refs: ${evaluation.expectedRefs.join(", ")}`);
	}
	if (evaluation.result.errors.length > 0) {
		lines.push(`Errors: ${evaluation.result.errors.join("; ")}`);
	}
	return lines.join("\n");
};

const formatToolSummary = (evaluation: CaseEvaluation): string => {
	const turns = evaluation.result.turnBreakdown?.length ?? 0;
	const skillsRead = evaluation.routing.readSkills.length;
	const refsRead = evaluation.routing.readRefs.length;
	const toolUsage = evaluation.result.toolUsage;
	const lines = [`Turns: ${turns}`, `Skills read: ${skillsRead}`, `Refs read: ${refsRead}`];
	if (toolUsage) {
		lines.push(`Write calls: ${toolUsage.writeCalls}`, `Edit calls: ${toolUsage.editCalls}`);
	}
	return lines.join(", ");
};

const summarizeVerificationStatus = (result: VerificationResult): string => {
	const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`;
	return `${result.label}: ${status}, ${result.durationMs}ms`;
};

const summarizeVerificationResults = (evaluation: CaseEvaluation): string => {
	const results = evaluation.result.verificationResults ?? [];
	if (results.length === 0) return "no verification commands were run";
	return results.map(summarizeVerificationStatus).join("; ");
};

const formatVerificationResults = (evaluation: CaseEvaluation): string => {
	const results = evaluation.result.verificationResults ?? [];
	if (results.length === 0) return "(no verification commands were run)";
	return results.map((result) => {
		const command = result.argv.join(" ");
		const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`;
		const stdout = result.stdout.trim();
		const stderr = result.stderr.trim();
		const sections = [
			`### ${result.label}`,
			`Command: ${command}`,
			`Status: ${status}`,
			`Duration: ${result.durationMs}ms`,
		];
		if (stdout.length > 0) sections.push(`stdout:\n\`\`\`\n${stdout}\n\`\`\``);
		if (stderr.length > 0) sections.push(`stderr:\n\`\`\`\n${stderr}\n\`\`\``);
		if (result.outputTruncated) sections.push("Output was truncated by the harness.");
		return sections.join("\n");
	}).join("\n\n");
};

const readArtifact = async (evalCase: ResolvedEvalCase, agentDir: string): Promise<string> => {
	const assertions = evalCase.fileAssertions ?? [];
	if (assertions.length === 0) return "(no artifact)";
	const artifactPath = resolveInsideRoot(agentDir, assertions[0].path);
	try {
		return await readFile(artifactPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(artifact not found)";
		throw error;
	}
};

const judgeCaseIdFor = (evalCase: ResolvedEvalCase): string => evalCase.bundleId ?? evalCase.id;

const judgeVariantTagFor = (evalCase: ResolvedEvalCase): string => evalCase.variantTag ?? "single";

const resolveJudgeCases = (
	evaluations: CaseEvaluation[],
	cases: ResolvedEvalCase[],
	bundles: Map<string, EvalBundle>,
): Map<string, { variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> }> => {
	const result = new Map<string, { variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> }>();
	const evalMap = new Map<string, CaseEvaluation>();
	const caseMap = new Map<string, ResolvedEvalCase>();
	for (const evaluation of evaluations) evalMap.set(evaluation.caseId, evaluation);
	for (const evalCase of cases) caseMap.set(evalCase.id, evalCase);

	for (const [bundleId, bundle] of bundles) {
		const variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> = [];
		for (const tag of bundle.variantTags) {
			const caseId = `${bundleId}:${tag}`;
			const evaluation = evalMap.get(caseId);
			const evalCase = caseMap.get(caseId);
			if (evaluation && evalCase) {
				variants.push({ evaluation, evalCase });
			}
		}
		if (variants.length > 0) {
			result.set(bundleId, { variants });
		}
	}

	for (const evalCase of cases) {
		if (evalCase.bundleId) continue;
		const evaluation = evalMap.get(evalCase.id);
		if (evaluation) {
			result.set(evalCase.id, { variants: [{ evaluation, evalCase }] });
		}
	}

	return result;
};

const collectArtifacts = async (
	evalCase: ResolvedEvalCase,
	evaluation: CaseEvaluation,
	agentDir: string,
): Promise<Record<string, string>> => {
	const captured = evaluation.result.capturedArtifacts;
	if (captured && Object.keys(captured).length > 0) return captured;
	const artifacts: Record<string, string> = {};
	for (const assertion of evalCase.fileAssertions ?? []) {
		const content = await readArtifact(
			{ ...evalCase, fileAssertions: [assertion] } as ResolvedEvalCase,
			agentDir,
		);
		if (content !== "(artifact not found)" && content !== "(no artifact)") {
			artifacts[assertion.path] = content;
		}
	}
	return artifacts;
};

const collectVariantFiles = async (
	evalCase: ResolvedEvalCase,
	artifacts: Record<string, string>,
	agentDir: string,
): Promise<Record<string, string>> => {
	const files: Record<string, string> = {};
	for (const [neutralPath, realPath] of Object.entries(evalCase.fixtureMapping ?? {})) {
		const sourcePath = resolveInsideRoot(agentDir, realPath);
		files[neutralPath] = await readFile(sourcePath, "utf-8");
	}
	for (const [artifactPath, content] of Object.entries(artifacts)) {
		files[artifactPath] = content;
	}
	return files;
};

const assembleJudgeSuiteInput = async (
	resolvedCases: Map<string, { variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> }>,
	agentDir: string,
): Promise<JudgeSuiteInput> => {
	const cases: JudgeCaseInput[] = [];
	for (const [caseId, { variants }] of resolvedCases) {
		const allArtifacts = await Promise.all(
			variants.map((v) => collectArtifacts(v.evalCase, v.evaluation, agentDir)),
		);
		const allFiles = await Promise.all(
			variants.map((v, index) => collectVariantFiles(v.evalCase, allArtifacts[index], agentDir)),
		);
		const prompt = variants[0].evalCase.prompt;
		const notes = variants[0].evalCase.notes ?? "";
		cases.push({
			caseId,
			safeCaseId: toSafePathSegment(caseId, "case"),
			prompt,
			notes,
			variants: variants.map((v, i) => ({
				tag: judgeVariantTagFor(v.evalCase),
				safeTag: toSafePathSegment(judgeVariantTagFor(v.evalCase), "variant"),
				files: allFiles[i],
				output: v.evaluation.result.outputText,
				stepTrace: v.evaluation.result.sanitizedStepTrace ?? [],
				verification: formatVerificationResults(v.evaluation),
				verificationSummary: summarizeVerificationResults(v.evaluation),
				tokens: v.evaluation.result.tokens,
				toolSummary: formatToolSummary(v.evaluation),
				routingTrace: formatRoutingTrace(v.evaluation),
				errors: v.evaluation.result.errors,
			})),
		});
	}
	return { cases };
};

const buildJudgeResponseSchema = (input: JudgeSuiteInput): string => JSON.stringify(
	{
		pass: "<true if the selected run shows clear skill benefit overall, false otherwise>",
		reportMarkdown: [
			"<judge-authored markdown report>",
			"Minimum sections: Executive Summary; Case Outcomes; Clear Skill Wins; No Clear Win or Regressions; Skill Feedback; Evidence Notes; Routing and Process Issues; Artifact Pointers.",
			"Use any clearer layout as long as those minimums are covered.",
		].join(" "),
		skillFeedback: [
			"<concrete feedback about what the skill guidance caused, missed, or should change; use observable evidence, not abstract quality language>",
		],
		cases: input.cases.map((testCase) => ({
			caseId: testCase.caseId,
			bundlePass: "<for multi-variant cases: true if this case shows a clear skill benefit; for single-variant cases: true if the submitted run passed the concrete task evidence>",
			skillBenefit: "<one of: clear | none | worse | inconclusive>",
			skillFeedback: [
				"<case-specific feedback for the skill, or an evidence gap when there is no skill variant/baseline>",
			],
			variants: testCase.variants.map((variant) => ({
				tag: variant.tag,
				taskPass: "<true if this individual run satisfied the concrete task evidence; false if its own verification/artifacts failed>",
				rationale: "<one sentence based on concrete evidence; do not encode skill-vs-baseline comparison as a task failure>",
			})),
			decisiveEvidence: [{
				kind: "<one of: verification | correctness | performance | routing | process | code-fact | inconclusive>",
				claim: "<observable claim, not an abstract score>",
				source: "<file path, command label/output, routing file, sanitized steps, or explicit evidence gap>",
			}],
		})),
	},
	null,
	2,
);

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const manifestForPrompt = (input: JudgeSuiteInput) => ({
	cases: input.cases.map((testCase) => ({
		caseId: testCase.caseId,
		workspacePath: `cases/${testCase.safeCaseId}`,
		prompt: testCase.prompt,
		notes: testCase.notes,
		variants: testCase.variants.map((variant) => ({
			tag: variant.tag,
			projectPath: `cases/${testCase.safeCaseId}/${variant.safeTag}/project`,
			agentOutputPath: `cases/${testCase.safeCaseId}/${variant.safeTag}/agent-output.md`,
			sanitizedStepsPath: `cases/${testCase.safeCaseId}/${variant.safeTag}/sanitized-steps.md`,
			verificationPath: `cases/${testCase.safeCaseId}/${variant.safeTag}/verification-output.md`,
			routingPath: `cases/${testCase.safeCaseId}/${variant.safeTag}/routing.md`,
			submittedFiles: Object.keys(variant.files).sort(),
			verificationSummary: variant.verificationSummary,
			routingSummary: oneLine(variant.routingTrace),
			apiCost: apiCostFromTokens(variant.tokens),
			toolSummary: variant.toolSummary,
			errors: variant.errors,
		})),
	})),
});

const writeJudgeWorkspaceFiles = async (
	layout: JudgeSandboxLayout,
	input: JudgeSuiteInput,
): Promise<void> => {
	await mkdir(resolveInsideRoot(layout.workspaceDir, "cases"), { recursive: true });
	await mkdir(resolveInsideRoot(layout.workspaceDir, "evidence"), { recursive: true });
	await writeFile(
		resolveInsideRoot(layout.workspaceDir, "suite-manifest.json"),
		JSON.stringify(manifestForPrompt(input), null, 2),
		"utf-8",
	);
	await writeFile(
		resolveInsideRoot(layout.workspaceDir, "README.md"),
		[
			"# Suite Judge Workspace",
			"",
			"Use suite-manifest.json for the compact index.",
			"Each case directory contains variant project files plus agent output, sanitized steps, verification output, and routing evidence.",
			"Temporary judge-created evidence should stay under evidence/.",
			"",
		].join("\n"),
		"utf-8",
	);
	for (const testCase of input.cases) {
		const caseRoot = resolveInsideRoot(layout.workspaceDir, path.join("cases", testCase.safeCaseId));
		await mkdir(caseRoot, { recursive: true });
		await writeFile(
			resolveInsideRoot(caseRoot, "case.md"),
			[
				`# ${testCase.caseId}`,
				"",
				"## Prompt",
				testCase.prompt,
				"",
				testCase.notes ? `## Notes\n${testCase.notes}\n` : "",
				"## Variants",
				...testCase.variants.map((variant) => `- ${variant.tag}: ${variant.safeTag}/project/`),
				"",
			].join("\n"),
			"utf-8",
		);
		for (const variant of testCase.variants) {
			const variantRoot = resolveInsideRoot(caseRoot, variant.safeTag);
			const projectRoot = resolveInsideRoot(variantRoot, "project");
			await mkdir(projectRoot, { recursive: true });
			for (const [filePath, content] of Object.entries(variant.files)) {
				const targetPath = resolveInsideRoot(projectRoot, filePath);
				await mkdir(path.dirname(targetPath), { recursive: true });
				await writeFile(targetPath, content, "utf-8");
			}
			await writeFile(
				resolveInsideRoot(variantRoot, "agent-output.md"),
				variant.output || "(no final agent output)",
				"utf-8",
			);
			await writeFile(
				resolveInsideRoot(variantRoot, "sanitized-steps.md"),
				variant.stepTrace.length > 0 ? variant.stepTrace.join("\n") : "(no sanitized step trace)",
				"utf-8",
			);
			await writeFile(
				resolveInsideRoot(variantRoot, "verification-output.md"),
				variant.verification,
				"utf-8",
			);
			await writeFile(
				resolveInsideRoot(variantRoot, "routing.md"),
				variant.routingTrace,
				"utf-8",
			);
			await writeFile(
				resolveInsideRoot(variantRoot, "errors.txt"),
				variant.errors.length > 0 ? variant.errors.join("\n") : "(no errors)",
				"utf-8",
			);
		}
	}
};

const buildJudgePrompt = (input: JudgeSuiteInput): string => {
	const responseSchema = buildJudgeResponseSchema(input);
	const manifest = JSON.stringify(manifestForPrompt(input), null, 2);

	return `You are an active investigative eval judge. Review all selected eval cases in one suite-level pass.

You are running in a scratch judge workspace. The compact index is suite-manifest.json, and detailed artifacts are under cases/. Temporary judge-created notes or scripts belong under evidence/.

Suite manifest:
${manifest}

Judging rules:
- Use autonomy to inspect the artifacts and choose the clearest report layout.
- Do not use abstract scorecards or subjective metrics such as architecture/readability/robustness/style scores.
- Every decisive claim must be observable or measurable: verification result, correctness edge case, performance/timing boundary, routing/read evidence, process trace, or code fact with a source path.
- Compare each case's variants side by side when multiple variants exist, and also look across cases for repeated skill benefit, repeated no-clear-win patterns, task failures, or systemic routing/process gaps.
- Some selected cases may have only one variant. For a single-variant case, judge whether that submitted run passed the concrete task evidence; do not claim skill-vs-baseline benefit without a baseline.
- Variant taskPass is only about whether that individual run satisfied the task's concrete verification/artifact evidence.
- Do not mark a skill variant taskPass=false merely because it failed to beat a baseline; that is a bundle/comparison outcome, not a task failure.
- Do not mark the skill as failed merely because the no-skill baseline failed. A no-skill task failure can be evidence for skill benefit when the skill variant passed.
- A single variant has only task outcome; do not infer skill-vs-baseline benefit without a baseline.
- The case bundle passes only when the skill variant clearly beats the baseline. Equivalent outputs are not a skill win.
- For single-variant cases, set bundlePass to true only when the submitted run passed the concrete task evidence; set skillBenefit to inconclusive unless there is a real baseline comparison.
- Provide concrete skill feedback: what the skill guidance caused, missed, or should change, tied to routing/process/code/performance evidence.
- If evidence is missing, report an evidence gap instead of guessing.
- You may run focused commands inside variant project directories when they answer a concrete correctness, performance, or evidence question. Keep any judge-created files under evidence/ and distinguish submitted code from your own scratch work.

Your markdown report may use any clear structure, but it must cover:
- Executive Summary
- Case Outcomes
- Clear Skill Wins
- No Clear Win or Regressions
- Skill Feedback
- Evidence Notes
- Routing and Process Issues
- Artifact Pointers

Respond in this exact JSON shape. Use raw JSON only, with no markdown fence and no prose outside the JSON:
${responseSchema}`;
};

const runPiJudge = async (params: {
	model: ModelSpec;
	thinking: string;
	input: JudgeSuiteInput;
	judgeAgentsPath: string;
	authSourcePath: string | null;
}): Promise<{ content: string; tokens: TokenUsage }> => {
	let layout: JudgeSandboxLayout | null = null;
	let launch: SandboxedProcessHandle | null = null;
	let processExited = false;
	let rl: ReturnType<typeof createInterface> | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	try {
		layout = await createJudgeSandbox({
			judgeAgentsPath: params.judgeAgentsPath,
			authSourcePath: params.authSourcePath,
		});
		await writeJudgeWorkspaceFiles(layout, params.input);

		const outputPath = path.join(layout.outputDir, "judge-output.json");
		const engine = createMandatorySandboxEngine();
		const prompt = buildJudgePrompt(params.input);
		const args = [
			"--mode", "rpc",
			"--no-session",
			"--no-extensions",
			"--tools", "read,bash,edit,write,grep,find,ls",
			"--provider", params.model.provider,
			"--model", params.model.id,
			"--thinking", params.thinking,
		];

		launch = await engine.launchWorker({
			command: "pi",
			args,
			env: process.env as NodeJS.ProcessEnv,
			policy: {
				model: params.model,
				sandboxWorkspaceDir: layout.workspaceDir,
				workerOutputPath: outputPath,
				sandboxHomeDir: layout.homeDir,
			},
		});

		let content = "";
		let tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		const stderrChunks: string[] = [];

		launch.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));

		rl = createInterface({ input: launch.stdout as NodeJS.ReadableStream & AsyncIterable<string> });
		rl.on("line", (line: string) => {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			if (event.type !== "agent_end") return;
			const messages = Array.isArray(event.messages) ? event.messages : [];
			content = collectAssistantText(messages);
			tokens = sumUsageFromMessages(messages);
			launch.stdin.end();
		});

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error("judge pi process timed out")), JUDGE_TIMEOUT_MS);
		});

		const exitPromise = (async () => {
			const exitCode = await launch!.waitForExit();
			processExited = true;
			rl?.close();
			if (!content && exitCode !== 0) {
				throw new Error(`pi judge exited with code ${exitCode}: ${stderrChunks.join("")}`);
			}
			return { content, tokens };
		})();

		launch.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

		return await Promise.race([exitPromise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		rl?.close();
		if (launch && !processExited) launch.kill();
		await launch?.cleanup().catch(() => undefined);
		await cleanupJudgeSandbox(layout);
	}
};

const collectJsonObjectCandidates = (raw: string): string[] => {
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(raw.slice(start, index + 1));
				start = -1;
			}
		}
	}

	return candidates;
};

const parseCandidate = (candidate: string): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(candidate) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
};

export const extractJson = (raw: string): string => {
	const candidates: string[] = [];
	for (const match of raw.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
		candidates.push(match[1].trim());
	}
	candidates.push(...collectJsonObjectCandidates(raw));

	const parseable = candidates
		.map((candidate) => ({ candidate, parsed: parseCandidate(candidate) }))
		.filter((entry): entry is { candidate: string; parsed: Record<string, unknown> } => Boolean(entry.parsed));
	const preferred = parseable.findLast((entry) =>
		Array.isArray(entry.parsed.cases) && typeof entry.parsed.reportMarkdown === "string"
	);
	if (preferred) return preferred.candidate;
	if (parseable.length > 0) return parseable[parseable.length - 1].candidate;
	return raw.trim();
};

const buildMissingCaseVerdict = (
	testCase: JudgeCaseInput,
	message: string,
): JudgeCaseVerdict => ({
	caseId: testCase.caseId,
	bundlePass: false,
	skillBenefit: "inconclusive",
	variants: testCase.variants.map((variant) => ({
		tag: variant.tag,
		taskPass: false,
		rationale: message,
	})),
	decisiveEvidence: [{
		kind: "inconclusive",
		claim: message,
		source: `cases/${testCase.safeCaseId}`,
	}],
	skillFeedback: [message],
});

const parseCaseVerdict = (
	rawCase: JudgeResponseSchema["cases"][number],
	expectedCase: JudgeCaseInput,
): JudgeCaseVerdict => {
	const returnedVariants = Array.isArray(rawCase.variants) ? rawCase.variants : [];
	const variants: JudgeVariantVerdict[] = returnedVariants.map((variant) => ({
		tag: String(variant.tag ?? ""),
		taskPass: typeof variant.taskPass === "boolean"
			? variant.taskPass
			: Boolean(variant.pass),
		rationale: String(variant.rationale ?? ""),
	})).filter((variant) => variant.tag.length > 0);

	for (const expectedVariant of expectedCase.variants) {
		if (!variants.some((variant) => variant.tag === expectedVariant.tag)) {
			variants.push({
				tag: expectedVariant.tag,
				taskPass: false,
				rationale: "no variant verdict returned by judge",
			});
		}
	}

	const decisiveEvidence: JudgeEvidenceItem[] = Array.isArray(rawCase.decisiveEvidence)
		? rawCase.decisiveEvidence.map((evidence) => ({
			kind: normalizeEvidenceKind(evidence.kind),
			claim: String(evidence.claim ?? ""),
			source: String(evidence.source ?? ""),
		})).filter((evidence) => evidence.claim.length > 0 || evidence.source.length > 0)
		: [];

	if (decisiveEvidence.length === 0) {
		decisiveEvidence.push({
			kind: "inconclusive",
			claim: "judge returned no decisive evidence",
			source: `cases/${expectedCase.safeCaseId}`,
		});
	}

	return {
		caseId: expectedCase.caseId,
		bundlePass: Boolean(rawCase.bundlePass),
		skillBenefit: normalizeSkillBenefit(rawCase.skillBenefit),
		variants,
		decisiveEvidence,
		skillFeedback: Array.isArray(rawCase.skillFeedback)
			? rawCase.skillFeedback.map((item) => String(item ?? "").trim()).filter(Boolean)
			: [],
	};
};

const parseJudgeResponse = (
	raw: string,
	input: JudgeSuiteInput,
	tokens: TokenUsage,
): JudgeSuiteVerdict => {
	const jsonStr = extractJson(raw);
	let parsed: JudgeResponseSchema;
	try {
		parsed = JSON.parse(jsonStr) as JudgeResponseSchema;
	} catch (error) {
		const excerpt = raw.slice(0, 800).replace(/\s+/g, " ").trim();
		throw new Error(`${errorMessage(error)}; raw judge response excerpt: ${excerpt}`);
	}
	if (!Array.isArray(parsed.cases)) {
		const excerpt = raw.slice(0, 800).replace(/\s+/g, " ").trim();
		throw new Error(`judge response missing cases; raw judge response excerpt: ${excerpt}`);
	}

	const rawCaseById = new Map(parsed.cases.map((testCase) => [String(testCase.caseId ?? ""), testCase]));
	const cases = input.cases.map((expectedCase) => {
		const rawCase = rawCaseById.get(expectedCase.caseId);
		if (!rawCase) {
			return buildMissingCaseVerdict(expectedCase, "no case verdict returned by judge");
		}
		return parseCaseVerdict(rawCase, expectedCase);
	});
	const missingCases = cases.some((testCase) =>
		testCase.decisiveEvidence.some((evidence) => evidence.claim === "no case verdict returned by judge")
	);

	return {
		pass: Boolean(parsed.pass) && !missingCases,
		reportMarkdown: String(parsed.reportMarkdown ?? "").trim() || "Judge returned no markdown report.",
		cases,
		skillFeedback: Array.isArray(parsed.skillFeedback)
			? parsed.skillFeedback.map((item) => String(item ?? "").trim()).filter(Boolean)
			: [],
		rawResponse: raw,
		judgeTokens: tokens,
	};
};

const buildJudgeErrorVerdict = (
	input: JudgeSuiteInput,
	message: string,
): JudgeSuiteVerdict => {
	const zeroTokens: TokenUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
	return {
		pass: false,
		reportMarkdown: [
			"## Executive Summary",
			"",
			"The suite judge failed before returning a parseable verdict.",
			"",
			"## Evidence Notes",
			"",
			`- Judge error: ${message}`,
			"",
			"## Artifact Pointers",
			"",
			"- Inspect the raw suite-verdict trace and per-case routing traces.",
			"",
		].join("\n"),
		cases: input.cases.map((testCase) => buildMissingCaseVerdict(
			testCase,
			`judge failed before returning a parseable verdict: ${message}`,
		)),
		skillFeedback: [`Judge failed before returning skill feedback: ${message}`],
		rawResponse: message,
		judgeTokens: zeroTokens,
	};
};

/** Attach suite-level judge verdicts without overwriting per-run task status. */
export const applyJudgeVerdicts = (
	evaluations: CaseEvaluation[],
	verdict: JudgeSuiteVerdict | null,
	cases: ResolvedEvalCase[],
): void => {
	if (!verdict) return;

	const caseById = new Map(cases.map((c) => [c.id, c]));
	const verdictByCaseId = new Map(verdict.cases.map((testCase) => [testCase.caseId, testCase]));
	for (const evaluation of evaluations) {
		const evalCase = caseById.get(evaluation.caseId);
		if (!evalCase) continue;

		const expectedCaseId = judgeCaseIdFor(evalCase);
		const caseVerdict = verdictByCaseId.get(expectedCaseId);
		evaluation.judgeSuiteVerdict = verdict;
		if (!caseVerdict) {
			continue;
		}

		evaluation.judgeVerdict = caseVerdict;
	}
};

export const runJudge = async (params: {
	evaluations: CaseEvaluation[];
	cases: ResolvedEvalCase[];
	bundles: Map<string, EvalBundle>;
	options: EvalRunOptions;
	agentDir: string;
}): Promise<JudgeSuiteVerdict | null> => {
	const { evaluations, cases, bundles, options, agentDir } = params;

	if (options.judgeDisabled) return null;

	const resolved = resolveJudgeCases(evaluations, cases, bundles);
	if (resolved.size === 0) return null;

	const judgeModelSpec = options.judgeModel ?? options.model;
	const input = await assembleJudgeSuiteInput(resolved, agentDir);
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const { content, tokens } = await runPiJudge({
				model: judgeModelSpec,
				thinking: options.judgeThinking,
				input,
				judgeAgentsPath: options.judgeAgentsPath,
				authSourcePath: options.evalAuthSource,
			});
			return parseJudgeResponse(content, input, tokens);
		} catch (error) {
			lastError = error;
			if (attempt < 2) {
				console.error(`[judge] Retrying suite judge: ${errorMessage(error)}`);
			}
		}
	}
	const message = errorMessage(lastError);
	console.error(`[judge] Failed suite judge: ${message}`);
	return buildJudgeErrorVerdict(input, message);
};
