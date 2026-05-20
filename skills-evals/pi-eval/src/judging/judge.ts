import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	apiCostFromTokens,
	type CaseEvaluation,
	type EvalBundle,
	type EvalRunOptions,
	type JudgeBundleVerdict,
	type JudgeDimensionScore,
	type JudgeVariantVerdict,
	type ModelSpec,
	type ResolvedEvalCase,
	type RoutingScorecard,
	type TokenUsage,
} from "../data/types.js";
import { errorMessage } from "../data/utils.js";
import { resolveInsideRoot } from "../runtime/policy/path-policy.js";
import { collectAssistantText, sumUsageFromMessages } from "../runtime/rpc/rpc-messages.js";
import { createMandatorySandboxEngine } from "../runtime/engine/sandbox-engine.js";
import { createJudgeSandbox, cleanupJudgeSandbox, type JudgeSandboxLayout } from "./judge-sandbox.js";

type JudgeVariantInput = {
	tag: string;
	code: string;
	artifacts: Record<string, string>;
	files: Record<string, string>;
	output: string;
	stepTrace: string[];
	verification: string;
	tokens: TokenUsage;
	toolSummary: string;
	routingTrace: string;
	errors: string[];
};

type JudgeBundleInput = {
	bundleId: string;
	prompt: string;
	notes: string;
	variants: JudgeVariantInput[];
};

type JudgeResponseSchema = {
	pass: boolean;
	verdict: string;
	evidenceSummary?: string;
	processSummary?: string;
	processFindings?: Array<{
		tag: string;
		score: number;
		traceEvidence: string;
		compilerEvidence: string;
		timingEvidence: string;
		gaps: string;
	}>;
	commandsRun?: string[];
	acceptanceCriteria?: string[];
	dimensions: Array<{
		name: string;
		scores: Record<string, number>;
		rationale: string;
	}>;
	variantVerdicts: Array<{
		tag: string;
		pass: boolean;
		rationale: string;
	}>;
	costAnalysis: string;
	recommendation: string;
};

const JUDGE_DIMENSIONS = [
	"architecture",
	"readability",
	"correctness",
	"robustness",
	"idiomatic style",
];

const JUDGE_TIMEOUT_MS = 900_000;

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

const resolveBundles = (
	evaluations: CaseEvaluation[],
	cases: ResolvedEvalCase[],
	bundles: Map<string, EvalBundle>,
): Map<string, { bundle: EvalBundle; variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> }> => {
	const result = new Map<string, { bundle: EvalBundle; variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }> }>();
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
		if (variants.length >= 2) {
			result.set(bundleId, { bundle, variants });
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

const assembleJudgeBundleInput = async (
	bundleId: string,
	variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }>,
	agentDir: string,
): Promise<JudgeBundleInput> => {
	const allArtifacts = await Promise.all(
		variants.map((v) => collectArtifacts(v.evalCase, v.evaluation, agentDir)),
	);
	const allFiles = await Promise.all(
		variants.map((v, index) => collectVariantFiles(v.evalCase, allArtifacts[index], agentDir)),
	);
	const prompt = variants[0].evalCase.prompt;
	const notes = variants[0].evalCase.notes ?? "";
	return {
		bundleId,
		prompt,
		notes,
		variants: variants.map((v, i) => {
			const artifacts = allArtifacts[i];
			const entries = Object.entries(artifacts);
			const code = entries.length > 0 ? entries[0][1] : "(no artifact)";
			return {
				tag: v.evalCase.variantTag ?? v.evalCase.id,
				code,
				artifacts,
				files: allFiles[i],
				output: v.evaluation.result.outputText,
				stepTrace: v.evaluation.result.sanitizedStepTrace ?? [],
				verification: formatVerificationResults(v.evaluation),
				tokens: v.evaluation.result.tokens,
				toolSummary: formatToolSummary(v.evaluation),
				routingTrace: formatRoutingTrace(v.evaluation),
				errors: v.evaluation.result.errors,
			};
		}),
	};
};

const buildJudgeResponseSchema = (variantTags: string[]): string => {
	const scoreShape: Record<string, string> = {};
	for (const tag of variantTags) scoreShape[tag] = "<1-10>";
	return JSON.stringify(
		{
				pass: "<true if skill variant demonstrates clear benefit over baseline, false otherwise>",
				verdict: "<one-line summary of whether skills helped>",
				evidenceSummary: "<one paragraph naming the decisive tests, timings, compiler-output checks, or trace findings>",
				processSummary: "<one paragraph comparing the agents' investigation process from sanitized traces>",
				processFindings: variantTags.map((tag) => ({
					tag,
					score: "<1-10 process score>",
					traceEvidence: "<what the sanitized trace shows this agent did>",
					compilerEvidence: "<compiler flags/output/disassembly/symbol inspection used, or explicit gap>",
					timingEvidence: "<timing/benchmark/allocation evidence used by the agent, or explicit gap>",
					gaps: "<important missing process evidence>",
				})),
				commandsRun: ["<commands the judge ran or inspected, including paths/boundaries>"],
				acceptanceCriteria: ["<criterion checked and whether it passed>"],
			dimensions: JUDGE_DIMENSIONS.map((name) => ({
				name,
				scores: scoreShape,
				rationale: "<one-line explanation>",
			})),
			variantVerdicts: variantTags.map((tag) => ({
				tag,
				pass: "<true/false>",
				rationale: "<one-line explanation for this variant's verdict>",
			})),
			costAnalysis: "<free-text cost-quality tradeoff analysis>",
			recommendation: "<concrete recommendation>",
		},
		null,
		2,
	);
};

const formatArtifactSections = (artifacts: Record<string, string>): string => {
	const entries = Object.entries(artifacts);
	if (entries.length === 0) return "```\n(no artifact)\n```";
	if (entries.length === 1) return `\`\`\`\n${entries[0][1]}\n\`\`\``;
	return entries
		.map(([filePath, content]) => `**${filePath}**\n\`\`\`\n${content}\n\`\`\``)
		.join("\n\n");
};

const writeJudgeWorkspaceFiles = async (
	layout: JudgeSandboxLayout,
	input: JudgeBundleInput,
): Promise<void> => {
	await mkdir(resolveInsideRoot(layout.workspaceDir, "variants"), { recursive: true });
	await mkdir(resolveInsideRoot(layout.workspaceDir, "evidence"), { recursive: true });
	await writeFile(
		resolveInsideRoot(layout.workspaceDir, "case.md"),
		[
			`# ${input.bundleId}`,
			"",
			"## Prompt",
			input.prompt,
			"",
			input.notes ? `## Notes\n${input.notes}\n` : "",
			"## Variants",
			...input.variants.map((variant) => `- ${variant.tag}: variants/${variant.tag}/`),
			"",
		].join("\n"),
		"utf-8",
	);
	for (const variant of input.variants) {
		const variantRoot = resolveInsideRoot(layout.workspaceDir, path.join("variants", variant.tag));
		await mkdir(variantRoot, { recursive: true });
		for (const [filePath, content] of Object.entries(variant.files)) {
			const targetPath = resolveInsideRoot(variantRoot, filePath);
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
	}
};

const buildJudgePrompt = (input: JudgeBundleInput): string => {
	const variantSections = input.variants.map((v) => {
		const cost = apiCostFromTokens(v.tokens);
		const tokenLine = `API cost: ${cost} (input: ${v.tokens.input}, output: ${v.tokens.output}, cached: ${v.tokens.cacheRead})`;
		const errorSection = v.errors.length > 0
			? `### Errors\n${v.errors.join("\n")}`
			: "";
		return `## Implementation: ${v.tag}
### Code
${formatArtifactSections(v.artifacts)}
### Agent reasoning
${v.output}
### Sanitized Model Steps
${v.stepTrace.length > 0 ? v.stepTrace.join("\n") : "(no sanitized step trace)"}
### Verification Output
${v.verification}
### Routing Trace
${v.routingTrace}
### ${tokenLine}
### Tool calls: ${v.toolSummary}${errorSection ? `\n${errorSection}` : ""}`;
	});

	const tokenCosts = input.variants
		.map((v) => `${v.tag}=${apiCostFromTokens(v.tokens)}`)
		.join(", ");

	const tags = input.variants.map((v) => v.tag);
	const responseSchema = buildJudgeResponseSchema(tags);

	const notesSection = input.notes
		? `\n## Case Notes\n${input.notes}\n`
		: "";

	return `You are an active investigative eval judge. You evaluate two implementations of the same task and decide whether skill knowledge helped.

## Task Prompt
${input.prompt}
${notesSection}
## Workspace

You are running in a scratch judge workspace. Each variant is available as a runnable project under:
${input.variants.map((v) => `- ${v.tag}: variants/${v.tag}/`).join("\n")}

You may read, edit, and write files in this scratch workspace. You may add temporary benchmark, allocation, compiler-output, or disassembly scaffolding under variants/* or evidence/. Do not treat scratch edits as submitted solution code. Run the original submitted code first before adding instrumentation.

${variantSections.join("\n\n")}

## Instructions

You are the sole evaluator. Your verdict determines pass/fail for this eval case.

### What to evaluate
1. **Code quality**: Rate each implementation 1-10 on: ${JUDGE_DIMENSIONS.join(", ")}
2. **Skill effectiveness**: Did the skill variant's routing (skills read, refs read) translate into measurably better code?
3. **Execution evidence**: Run or inspect tests, timing boundaries, compiler output, traces, allocation behavior, and disassembly as needed.
4. **Agent behavior**: Use sanitized model steps to see whether the agent inspected the right files, ran useful checks, used compiler/build flags, kept large output filtered, and avoided blind edits.
5. **Pass/fail verdict**: For each variant and overall.

### Verdict criteria
- The **skill variant PASSES** if it demonstrates clear quality improvement over baseline that can be attributed to the skill knowledge it received. Look at the routing trace — did it read the expected skills/refs, and did that knowledge improve the code?
- The **skill variant FAILS** if: it produced equivalent or worse code than baseline, it didn't read expected skills/refs, or infrastructure errors prevented execution.
- The **noskill/baseline variant PASSES** if it produced reasonable working code for the task.
- The **noskill/baseline variant FAILS** if it failed to produce working code or had errors that prevented execution.
- The **bundle PASSES** if the skill variant demonstrates clear benefit over baseline.
- If required verification commands fail for a variant, treat that as a serious correctness issue even if the code looks plausible.
- Do not reward performance claims unless they are supported by same-boundary verification output, your own scratch investigation, or a clearly stated plan without invented numbers.
- Prefer commands that answer concrete questions: tests pass, benchmark boundary, allocation in hot loops, compiler output surprises, and whether the compared timings measure the same work.
- In processFindings, explicitly say whether each agent used targeted Zig commands such as optimized builds, --verbose, emitted assembly, nm, objdump, allocator counters, or timing runs. If it did not, call that out as a process gap even if the final code is good.
- Treat raw large compiler output as low quality process evidence unless the agent filtered it to the target symbols, functions, or flags it needed.
- If you cannot run a command, report that as an evidence gap instead of guessing.

### Cost analysis
- API costs (input + output): ${tokenCosts}
- Cached tokens are ~90% cheaper and excluded from API cost above.
- Is the quality delta worth the extra cost?

Respond in this exact JSON format (no markdown fences, just raw JSON):
${responseSchema}`;
};

const runPiJudge = async (params: {
	model: ModelSpec;
	thinking: string;
	input: JudgeBundleInput;
	judgeAgentsPath: string;
	authSourcePath: string | null;
}): Promise<{ content: string; tokens: TokenUsage }> => {
	let layout: JudgeSandboxLayout | null = null;

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

		const launch = await engine.launchWorker({
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

		const rl = createInterface({ input: launch.stdout as NodeJS.ReadableStream & AsyncIterable<string> });
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
			setTimeout(() => reject(new Error("judge pi process timed out")), JUDGE_TIMEOUT_MS);
		});

		const exitPromise = (async () => {
			const exitCode = await launch.waitForExit();
			rl.close();
			if (!content && exitCode !== 0) {
				throw new Error(`pi judge exited with code ${exitCode}: ${stderrChunks.join("")}`);
			}
			return { content, tokens };
		})();

		launch.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

		return await Promise.race([exitPromise, timeoutPromise]);
	} finally {
		await cleanupJudgeSandbox(layout);
	}
};

const extractJson = (raw: string): string => {
	const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) return fenceMatch[1].trim();
	const braceStart = raw.indexOf("{");
	const braceEnd = raw.lastIndexOf("}");
	if (braceStart >= 0 && braceEnd > braceStart) return raw.slice(braceStart, braceEnd + 1);
	return raw;
};

const parseJudgeResponse = (
	raw: string,
	bundleId: string,
	variantTags: string[],
	tokens: TokenUsage,
): JudgeBundleVerdict => {
	const jsonStr = extractJson(raw);
	const parsed = JSON.parse(jsonStr) as JudgeResponseSchema;
	const dimensions: JudgeDimensionScore[] = (parsed.dimensions ?? []).map((d) => {
		const scores: Record<string, number> = {};
		for (const tag of variantTags) {
			scores[tag] = Number(d.scores?.[tag]) || 0;
		}
		return {
			name: String(d.name ?? ""),
			scores,
			rationale: String(d.rationale ?? ""),
		};
	});
	const variantVerdicts: JudgeVariantVerdict[] = (parsed.variantVerdicts ?? []).map((v) => ({
		tag: String(v.tag ?? ""),
		pass: Boolean(v.pass),
		rationale: String(v.rationale ?? ""),
	}));
	// Ensure every variant tag has a verdict (default to fail if missing)
	for (const tag of variantTags) {
		if (!variantVerdicts.some((v) => v.tag === tag)) {
			variantVerdicts.push({ tag, pass: false, rationale: "no verdict returned by judge" });
		}
	}
	return {
		bundleId,
		variantTags,
		pass: Boolean(parsed.pass),
		verdict: String(parsed.verdict ?? ""),
		evidenceSummary: String(parsed.evidenceSummary ?? ""),
		processSummary: String(parsed.processSummary ?? ""),
		processFindings: Array.isArray(parsed.processFindings)
			? parsed.processFindings.map((finding) => {
				const record = finding as Record<string, unknown>;
				return {
					tag: String(record.tag ?? ""),
					score: Number(record.score ?? 0),
					traceEvidence: String(record.traceEvidence ?? ""),
					compilerEvidence: String(record.compilerEvidence ?? ""),
					timingEvidence: String(record.timingEvidence ?? ""),
					gaps: String(record.gaps ?? ""),
				};
			})
			: [],
		commandsRun: Array.isArray(parsed.commandsRun) ? parsed.commandsRun.map(String) : [],
		acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria.map(String) : [],
		dimensions,
		variantVerdicts,
		costAnalysis: String(parsed.costAnalysis ?? ""),
		recommendation: String(parsed.recommendation ?? ""),
		rawResponse: raw,
		judgeTokens: tokens,
	};
};

/** Apply judge verdicts to evaluations, setting pass/fail status. */
export const applyJudgeVerdicts = (
	evaluations: CaseEvaluation[],
	verdicts: Map<string, JudgeBundleVerdict>,
	cases: ResolvedEvalCase[],
): void => {
	const caseById = new Map(cases.map((c) => [c.id, c]));
	for (const evaluation of evaluations) {
		const evalCase = caseById.get(evaluation.caseId);
		if (!evalCase?.bundleId) continue;
		const verdict = verdicts.get(evalCase.bundleId);
		if (!verdict) continue;

		evaluation.judgeVerdict = verdict;

		const variantVerdict = verdict.variantVerdicts.find(
			(v) => v.tag === evalCase.variantTag,
		);
		if (variantVerdict) {
			evaluation.status = variantVerdict.pass ? "pass" : "fail";
			if (!variantVerdict.pass) {
				evaluation.reasons = [`JUDGE: ${variantVerdict.rationale}`];
				evaluation.failureReasons = [{
					category: "TASK_FAILURE",
					message: variantVerdict.rationale,
				}];
			}
		}
	}
};

export const runJudge = async (params: {
	evaluations: CaseEvaluation[];
	cases: ResolvedEvalCase[];
	bundles: Map<string, EvalBundle>;
	options: EvalRunOptions;
	agentDir: string;
}): Promise<Map<string, JudgeBundleVerdict>> => {
	const { evaluations, cases, bundles, options, agentDir } = params;
	const verdicts = new Map<string, JudgeBundleVerdict>();

	if (options.judgeDisabled) return verdicts;

	const resolved = resolveBundles(evaluations, cases, bundles);
	if (resolved.size === 0) return verdicts;

	const judgeModelSpec = options.judgeModel ?? options.model;

	for (const [bundleId, { bundle, variants }] of resolved) {
		try {
			const input = await assembleJudgeBundleInput(bundleId, variants, agentDir);
			const { content, tokens } = await runPiJudge({
				model: judgeModelSpec,
				thinking: options.judgeThinking,
				input,
				judgeAgentsPath: options.judgeAgentsPath,
				authSourcePath: options.evalAuthSource,
			});
			const verdict = parseJudgeResponse(content, bundleId, bundle.variantTags, tokens);
			verdicts.set(bundleId, verdict);
		} catch (error) {
			console.error(`[judge] Failed for bundle ${bundleId}: ${errorMessage(error)}`);
		}
	}

	return verdicts;
};
