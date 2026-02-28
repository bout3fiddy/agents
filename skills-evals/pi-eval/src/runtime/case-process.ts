import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { BootstrapProfile, CaseRunResult, EvalCase, ModelSpec } from "../data/types.js";
import { fileExists } from "../data/utils.js";
import { buildWorkerEnv } from "./worker-contract.js";

const CASE_TIMEOUT_MS = 180_000;

type RpcState = {
	promptError: string | null;
	waitForAgentEnd: () => Promise<void>;
	onLine: (line: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
	let timeoutId: NodeJS.Timeout;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	const result = await Promise.race([promise, timeoutPromise]);
	clearTimeout(timeoutId);
	return result;
};

const waitForFile = async (filePath: string, timeoutMs = 10_000, intervalMs = 250): Promise<boolean> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await fileExists(filePath)) return true;
		await sleep(intervalMs);
	}
	return false;
};

const createRpcState = (): RpcState => {
	const pendingResolvers: Array<() => void> = [];
	let pendingAgentEnds = 0;
	let promptError: string | null = null;

	const waitForAgentEnd = () =>
		new Promise<void>((resolve) => {
			if (pendingAgentEnds > 0) {
				pendingAgentEnds -= 1;
				resolve();
				return;
			}
			pendingResolvers.push(resolve);
		});

	const onLine = (line: string) => {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "response" && event.command === "prompt" && event.success === false) {
			promptError = event.error ?? "prompt rejected";
		}
		if (event.type !== "agent_end") return;
		const resolve = pendingResolvers.shift();
		if (resolve) resolve();
		else pendingAgentEnds += 1;
	};

	return {
		get promptError() {
			return promptError;
		},
		waitForAgentEnd,
		onLine,
	};
};

const buildWorkerArgs = (
	model: ModelSpec,
	thinkingLevel: string,
	tools: string[],
	extensionEntry: string,
): string[] => {
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionEntry,
		"--tools",
		tools.join(","),
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--thinking",
		thinkingLevel,
	];
	return args;
};

export const buildStubResult = (caseId: string, dryRun: boolean, errors: string[]): CaseRunResult => ({
	caseId,
	dryRun,
	model: null,
	skillInvocations: [],
	skillAttempts: [],
	refInvocations: [],
	refAttempts: [],
	outputText: "",
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	durationMs: 0,
	errors,
	workspaceDir: null,
});

const collectWorkerResult = async (params: {
	outputPath: string;
	evalCase: EvalCase;
	dryRun: boolean;
	stderrChunks: string[];
	promptError: string | null;
}): Promise<CaseRunResult> => {
	const { outputPath, evalCase, dryRun, stderrChunks, promptError } = params;
	const outputReady = await waitForFile(outputPath, 15_000);
	const stderrLines = stderrChunks.map((line) => line.trim()).filter(Boolean);
	if (!outputReady) {
		return buildStubResult(evalCase.id, dryRun, [promptError ?? "no output from worker", ...stderrLines]);
	}
	const raw = await readFile(outputPath, "utf-8");
	const result = JSON.parse(raw) as CaseRunResult;
	if (promptError) result.errors.push(promptError);
	if (stderrLines.length > 0) result.errors.push(...stderrLines);
	return result;
};

export const runCaseProcess = async (params: {
	evalCase: EvalCase;
	model: ModelSpec;
	agentDir: string;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	extensionEntry: string;
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string | null;
	readDenyPaths: string[];
	globalInstructionsPath?: string;
	homeDir?: string;
}): Promise<CaseRunResult> => {
	const {
		evalCase,
		model,
		agentDir,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		extensionEntry,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash,
		readDenyPaths,
		globalInstructionsPath,
		homeDir,
	} = params;
	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const outputDir = path.join(tmpdir(), "pi-eval", randomUUID());
	const outputPath = path.join(outputDir, `${evalCase.id}.json`);
	const env = buildWorkerEnv(
		{
			outputPath,
			caseId: evalCase.id,
			dryRun,
			turnCount: prompts.length,
			agentDir,
			allowedTools: tools,
			readDenyPaths,
			bootstrapProfile,
			availableSkills,
			bootstrapManifestHash,
			globalInstructionsPath,
			homeDir,
		},
		process.env,
	);

	const proc = spawn("pi", buildWorkerArgs(model, thinkingLevel, tools, extensionEntry), {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stderrChunks: string[] = [];
	proc.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

	const rpcState = createRpcState();
	const rl = createInterface({ input: proc.stdout });
	rl.on("line", rpcState.onLine);

	try {
		for (const prompt of prompts) {
			proc.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
			await withTimeout(rpcState.waitForAgentEnd(), CASE_TIMEOUT_MS, `Case ${evalCase.id}`);
			if (rpcState.promptError) break;
		}

		const closePromise = new Promise<void>((resolve, reject) => {
			proc.on("close", () => resolve());
			proc.on("error", (error) => reject(error));
		});

		const resultPromise = collectWorkerResult({
			outputPath,
			evalCase,
			dryRun,
			stderrChunks,
			promptError: rpcState.promptError,
		});
		const result = await resultPromise;
		if (!proc.killed) proc.kill();
		await withTimeout(closePromise, 10_000, `Case ${evalCase.id} shutdown`);
		return result;
	} finally {
		rl.close();
		await rm(outputDir, { recursive: true, force: true });
	}
};
