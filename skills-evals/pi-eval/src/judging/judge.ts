import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
	CaseEvaluation,
	EvalBundle,
	EvalRunOptions,
	JudgeBundleVerdict,
	JudgeDimensionScore,
	ModelSpec,
	ResolvedEvalCase,
	TokenUsage,
} from "../data/types.js";
import { errorMessage } from "../data/utils.js";
import { collectAssistantText, sumUsageFromMessages } from "../runtime/rpc-messages.js";

type JudgeVariantInput = {
	tag: string;
	code: string;
	output: string;
	tokens: TokenUsage;
	toolSummary: string;
};

type JudgeBundleInput = {
	bundleId: string;
	prompt: string;
	variants: JudgeVariantInput[];
};

type JudgeResponseSchema = {
	dimensions: Array<{
		name: string;
		scores: Record<string, number>;
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

const JUDGE_TIMEOUT_MS = 120_000;

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

const readArtifact = async (evalCase: ResolvedEvalCase, agentDir: string): Promise<string> => {
	const assertions = evalCase.fileAssertions ?? [];
	if (assertions.length === 0) return "(no artifact)";
	const artifactPath = path.join(agentDir, assertions[0].path);
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

const assembleJudgeBundleInput = async (
	bundleId: string,
	variants: Array<{ evaluation: CaseEvaluation; evalCase: ResolvedEvalCase }>,
	agentDir: string,
): Promise<JudgeBundleInput> => {
	const codes = await Promise.all(variants.map((v) => readArtifact(v.evalCase, agentDir)));
	const prompt = variants[0].evalCase.prompt;
	return {
		bundleId,
		prompt,
		variants: variants.map((v, i) => ({
			tag: v.evalCase.variantTag ?? v.evalCase.id,
			code: codes[i],
			output: v.evaluation.result.outputText,
			tokens: v.evaluation.result.tokens,
			toolSummary: formatToolSummary(v.evaluation),
		})),
	};
};

const buildJudgeResponseSchema = (variantTags: string[]): string => {
	const scoreShape: Record<string, string> = {};
	for (const tag of variantTags) scoreShape[tag] = "<1-10>";
	return JSON.stringify(
		{
			dimensions: JUDGE_DIMENSIONS.map((name) => ({
				name,
				scores: scoreShape,
				rationale: "<one-line explanation>",
			})),
			costAnalysis: "<free-text cost-quality tradeoff analysis>",
			recommendation: "<concrete recommendation>",
		},
		null,
		2,
	);
};

const buildJudgePrompt = (input: JudgeBundleInput): string => {
	const variantSections = input.variants.map((v) => {
		const tokenLine = `Token cost: ${v.tokens.totalTokens} (input: ${v.tokens.input}, output: ${v.tokens.output}, cached: ${v.tokens.cacheRead})`;
		return `## Implementation: ${v.tag}
### Code
\`\`\`
${v.code}
\`\`\`
### Agent reasoning
${v.output}
### ${tokenLine}
### Tool calls: ${v.toolSummary}`;
	});

	const tokenCosts = input.variants
		.map((v) => `${v.tag}=${v.tokens.totalTokens}`)
		.join(", ");

	const tags = input.variants.map((v) => v.tag);
	const responseSchema = buildJudgeResponseSchema(tags);

	return `You are an expert code reviewer judging ${input.variants.length} implementations of the same task.

## Task Prompt
${input.prompt}

${variantSections.join("\n\n")}

## Instructions
Rate each implementation 1-10 on these dimensions. Be brutally honest.
If any implementation is worse or the same, say so.

Dimensions: ${JUDGE_DIMENSIONS.join(", ")}

Then analyze the cost-quality tradeoff:
- Token costs: ${tokenCosts}
- Is the quality delta worth the token cost?
- Give a concrete recommendation.

Respond in this exact JSON format (no markdown fences, just raw JSON):
${responseSchema}`;
};

const runPiJudge = (params: {
	model: ModelSpec;
	thinking: string;
	prompt: string;
}): Promise<{ content: string; tokens: TokenUsage }> => {
	return new Promise((resolve, reject) => {
		const args = [
			"--mode", "rpc",
			"--no-session",
			"--no-extensions",
			"--provider", params.model.provider,
			"--model", params.model.id,
			"--thinking", params.thinking,
		];
		const child = spawn("pi", args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		let content = "";
		let tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		let settled = false;
		const stderrChunks: string[] = [];

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error("judge pi process timed out"));
		}, JUDGE_TIMEOUT_MS);

		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve({ content, tokens });
		};

		child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
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
			child.stdin.end();
		});

		child.on("close", (code) => {
			rl.close();
			if (!content && code !== 0) {
				settle(new Error(`pi judge exited with code ${code}: ${stderrChunks.join("")}`));
				return;
			}
			settle();
		});

		child.on("error", (err) => settle(err));

		child.stdin.write(`${JSON.stringify({ type: "prompt", message: params.prompt })}\n`);
	});
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
	return {
		bundleId,
		variantTags,
		dimensions,
		costAnalysis: String(parsed.costAnalysis ?? ""),
		recommendation: String(parsed.recommendation ?? ""),
		rawResponse: raw,
		judgeTokens: tokens,
	};
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
			const prompt = buildJudgePrompt(input);
			const { content, tokens } = await runPiJudge({
				model: judgeModelSpec,
				thinking: options.judgeThinking,
				prompt,
			});
			const verdict = parseJudgeResponse(content, bundleId, bundle.variantTags, tokens);
			verdicts.set(bundleId, verdict);
		} catch (error) {
			console.error(`[judge] Failed for bundle ${bundleId}: ${errorMessage(error)}`);
		}
	}

	return verdicts;
};
