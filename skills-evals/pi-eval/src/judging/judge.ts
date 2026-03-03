import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
	CaseEvaluation,
	EvalCase,
	EvalRunOptions,
	JudgeDimension,
	JudgeVerdict,
	ModelSpec,
	TokenUsage,
} from "../data/types.js";
import { collectAssistantText, sumUsageFromMessages } from "../runtime/rpc-messages.js";

type ResolvedPair = {
	skill: CaseEvaluation;
	control: CaseEvaluation;
	skillCase: EvalCase;
	controlCase: EvalCase;
};

type JudgeInput = {
	prompt: string;
	skillCode: string;
	controlCode: string;
	skillOutput: string;
	controlOutput: string;
	skillTokens: TokenUsage;
	controlTokens: TokenUsage;
	skillToolSummary: string;
	controlToolSummary: string;
};

type JudgeResponseSchema = {
	dimensions: Array<{
		name: string;
		skillScore: number;
		controlScore: number;
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

const JUDGE_RESPONSE_SCHEMA = JSON.stringify(
	{
		dimensions: JUDGE_DIMENSIONS.map((name) => ({
			name,
			skillScore: "<1-10>",
			controlScore: "<1-10>",
			rationale: "<one-line explanation>",
		})),
		costAnalysis: "<free-text cost-quality tradeoff analysis>",
		recommendation: "<concrete recommendation>",
	},
	null,
	2,
);

const JUDGE_TIMEOUT_MS = 120_000;

const resolvePairs = (
	evaluations: CaseEvaluation[],
	cases: EvalCase[],
): Map<string, ResolvedPair> => {
	const pairs = new Map<string, ResolvedPair>();
	const evalMap = new Map<string, CaseEvaluation>();
	const caseMap = new Map<string, EvalCase>();
	for (const evaluation of evaluations) evalMap.set(evaluation.caseId, evaluation);
	for (const evalCase of cases) caseMap.set(evalCase.id, evalCase);

	for (const evalCase of cases) {
		if (!evalCase.controlFor) continue;
		const baseId = evalCase.controlFor;
		const controlId = evalCase.id;
		const skillEval = evalMap.get(baseId);
		const controlEval = evalMap.get(controlId);
		const skillCase = caseMap.get(baseId);
		const controlCase = caseMap.get(controlId);
		if (!skillEval || !controlEval || !skillCase || !controlCase) continue;
		pairs.set(baseId, { skill: skillEval, control: controlEval, skillCase, controlCase });
	}
	return pairs;
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

const readArtifact = async (evalCase: EvalCase, agentDir: string): Promise<string> => {
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

const assembleJudgeInput = async (
	pair: ResolvedPair,
	agentDir: string,
): Promise<JudgeInput> => {
	const [skillCode, controlCode] = await Promise.all([
		readArtifact(pair.skillCase, agentDir),
		readArtifact(pair.controlCase, agentDir),
	]);
	return {
		prompt: pair.skillCase.prompt,
		skillCode,
		controlCode,
		skillOutput: pair.skill.result.outputText,
		controlOutput: pair.control.result.outputText,
		skillTokens: pair.skill.result.tokens,
		controlTokens: pair.control.result.tokens,
		skillToolSummary: formatToolSummary(pair.skill),
		controlToolSummary: formatToolSummary(pair.control),
	};
};

const buildJudgePrompt = (input: JudgeInput): string => {
	const tokenDiff = input.skillTokens.totalTokens - input.controlTokens.totalTokens;
	const diffLabel = tokenDiff >= 0 ? `+${tokenDiff}` : `${tokenDiff}`;
	return `You are an expert code reviewer judging two implementations of the same task.

## Task Prompt
${input.prompt}

## Implementation A (skill-assisted agent)
### Code
\`\`\`
${input.skillCode}
\`\`\`
### Agent reasoning
${input.skillOutput}
### Token cost: ${input.skillTokens.totalTokens} (input: ${input.skillTokens.input}, output: ${input.skillTokens.output}, cached: ${input.skillTokens.cacheRead})
### Tool calls: ${input.skillToolSummary}

## Implementation B (barebones agent — no skill directives)
### Code
\`\`\`
${input.controlCode}
\`\`\`
### Agent reasoning
${input.controlOutput}
### Token cost: ${input.controlTokens.totalTokens} (input: ${input.controlTokens.input}, output: ${input.controlTokens.output}, cached: ${input.controlTokens.cacheRead})
### Tool calls: ${input.controlToolSummary}

## Instructions
Rate each implementation 1-10 on these dimensions. Be brutally honest.
If the skill-assisted version is worse or the same, say so.

Dimensions: ${JUDGE_DIMENSIONS.join(", ")}

Then analyze the cost-quality tradeoff:
- Implementation A cost ${input.skillTokens.totalTokens} tokens, B cost ${input.controlTokens.totalTokens} tokens (${diffLabel} difference)
- Is the quality delta worth the token cost?
- Give a concrete recommendation: reduce skill token cost, strengthen skill directives, or keep as-is.

Respond in this exact JSON format (no markdown fences, just raw JSON):
${JUDGE_RESPONSE_SCHEMA}`;
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

const parseJudgeResponse = (raw: string, pairId: string, controlId: string, tokens: TokenUsage): JudgeVerdict => {
	const jsonStr = extractJson(raw);
	const parsed = JSON.parse(jsonStr) as JudgeResponseSchema;
	const dimensions: JudgeDimension[] = (parsed.dimensions ?? []).map((d) => ({
		name: String(d.name ?? ""),
		skillScore: Number(d.skillScore) || 0,
		controlScore: Number(d.controlScore) || 0,
		rationale: String(d.rationale ?? ""),
	}));
	return {
		pairId,
		controlId,
		dimensions,
		costAnalysis: String(parsed.costAnalysis ?? ""),
		recommendation: String(parsed.recommendation ?? ""),
		rawResponse: raw,
		judgeTokens: tokens,
	};
};

export const runJudge = async (params: {
	evaluations: CaseEvaluation[];
	cases: EvalCase[];
	options: EvalRunOptions;
	agentDir: string;
}): Promise<Map<string, JudgeVerdict>> => {
	const { evaluations, cases, options, agentDir } = params;
	const verdicts = new Map<string, JudgeVerdict>();

	if (options.judgeDisabled) return verdicts;

	const pairs = resolvePairs(evaluations, cases);
	if (pairs.size === 0) return verdicts;

	const judgeModelSpec = options.judgeModel ?? options.model;

	for (const [pairId, pair] of pairs) {
		try {
			const input = await assembleJudgeInput(pair, agentDir);
			const prompt = buildJudgePrompt(input);
			const { content, tokens } = await runPiJudge({
				model: judgeModelSpec,
				thinking: options.judgeThinking,
				prompt,
			});
			const verdict = parseJudgeResponse(content, pairId, pair.control.caseId, tokens);
			verdicts.set(pairId, verdict);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[judge] Failed for pair ${pairId}: ${message}`);
		}
	}

	return verdicts;
};
