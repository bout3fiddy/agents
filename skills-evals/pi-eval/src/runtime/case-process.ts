import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
	BootstrapProfile,
	CaseRunResult,
	EvalCase,
	ModelSpec,
	RpcDiagnostics,
} from "../data/types.js";
import {
	fileExists,
	parsePositiveInt,
	sleep,
	withTimeout,
} from "../data/utils.js";
import { buildWorkerEnv } from "./worker-contract.js";
import { toSafePathSegment } from "./path-policy.js";
import {
	GUEST_HOME_DIR,
	GUEST_OUTPUT_DIR,
	GUEST_WORKSPACE_DIR,
	hostPathToGuest,
	mapReadDenyPathsToGuest,
} from "./guest-paths.js";
import { buildTimeoutDiagnosticsHint, persistRpcDiagnostics } from "./rpc-diagnostics.js";
import { createRpcState } from "./rpc-state.js";
import {
	createMandatorySandboxEngine,
	type SandboxEngine,
} from "./sandbox-engine.js";

const DEFAULT_CASE_TIMEOUT_MS = 300_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const parsePositiveIntEnv = (name: string, fallback: number): number =>
	parsePositiveInt(process.env[name], fallback);

const waitForFile = async (filePath: string, timeoutMs = 10_000, intervalMs = 250): Promise<boolean> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await fileExists(filePath)) return true;
		await sleep(intervalMs);
	}
	return false;
};

const buildWorkerArgs = (
	model: ModelSpec,
	thinkingLevel: string,
	tools: string[],
	extensionEntry: string,
): string[] => [
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
	if (result.workerReady !== true) {
		return buildStubResult(evalCase.id, dryRun, [
			"eval worker extension handshake missing",
			...stderrLines,
		]);
	}
	if (promptError) result.errors.push(promptError);
	if (stderrLines.length > 0) result.errors.push(...stderrLines);
	return result;
};

const pushUniqueError = (errors: string[], message: string) => {
	if (!errors.includes(message)) errors.push(message);
};

const attachRpcDiagnostics = (result: CaseRunResult, diagnostics: RpcDiagnostics) => {
	result.rpcDiagnostics = diagnostics;
	if (diagnostics.parseErrorCount > 0) {
		pushUniqueError(
			result.errors,
			`rpc diagnostics: ${diagnostics.parseErrorCount} non-JSON line(s) in RPC stream`,
		);
	}
	const maxDetailedAnomalies = 3;
	for (const anomaly of diagnostics.anomalies.slice(0, maxDetailedAnomalies)) {
		pushUniqueError(result.errors, `rpc diagnostics: ${anomaly}`);
	}
	if (diagnostics.anomalies.length > maxDetailedAnomalies) {
		pushUniqueError(
			result.errors,
			`rpc diagnostics: ${diagnostics.anomalies.length - maxDetailedAnomalies} additional anomaly/anomalies omitted`,
		);
	}
};

export const runCaseProcess = async (params: {
	evalCase: EvalCase;
	model: ModelSpec;
	cwd: string;
	dryRun: boolean;
	thinkingLevel: string;
	tools: string[];
	extensionEntry: string;
	bootstrapProfile: BootstrapProfile;
	availableSkills: string[];
	bootstrapManifestHash: string | null;
	readDenyPaths: string[];
	homeDir?: string;
	sandboxEngine?: SandboxEngine;
}): Promise<CaseRunResult> => {
	const {
		evalCase,
		model,
		cwd,
		dryRun,
		thinkingLevel,
		tools,
		extensionEntry,
		bootstrapProfile,
		availableSkills,
		bootstrapManifestHash,
		readDenyPaths,
		homeDir,
		sandboxEngine,
	} = params;
	const prompts = [evalCase.prompt, ...(evalCase.turns ?? [])];
	const caseTimeoutMs = parsePositiveIntEnv("PI_EVAL_CASE_TIMEOUT_MS", DEFAULT_CASE_TIMEOUT_MS);
	const shutdownTimeoutMs = parsePositiveIntEnv(
		"PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS",
		DEFAULT_SHUTDOWN_TIMEOUT_MS,
	);
	const outputDir = path.join(tmpdir(), "pi-eval", randomUUID());
	const outputFile = `${toSafePathSegment(evalCase.id, "case")}.json`;
	const outputPath = path.join(outputDir, outputFile);
	const rpcTraceDir = process.env.PI_EVAL_RPC_TRACE_DIR?.trim() || "";
	const rpcTracePath = rpcTraceDir.length > 0
		? path.join(path.resolve(rpcTraceDir), `${toSafePathSegment(evalCase.id, "case")}.jsonl`)
		: null;
	const rpcDiagnosticsPath = rpcTracePath
		? path.join(path.dirname(rpcTracePath), `${toSafePathSegment(evalCase.id, "case")}.diagnostics.json`)
		: null;
	const guestOutputPath = `${GUEST_OUTPUT_DIR}/${outputFile}`;
	const guestExtensionEntry = hostPathToGuest(extensionEntry, cwd, GUEST_WORKSPACE_DIR);
	const guestReadDenyPaths = mapReadDenyPathsToGuest({
		readDenyPaths,
		sandboxWorkspaceDir: cwd,
		sandboxHomeDir: homeDir,
	});
	const env = buildWorkerEnv(
		{
			outputPath: guestOutputPath,
			caseId: evalCase.id,
			dryRun,
			turnCount: prompts.length,
			agentDir: GUEST_WORKSPACE_DIR,
			allowedTools: tools,
			readDenyPaths: guestReadDenyPaths,
			bootstrapProfile,
			availableSkills,
			bootstrapManifestHash,
			homeDir: GUEST_HOME_DIR,
		},
		process.env,
	);
	await mkdir(outputDir, { recursive: true });
	if (rpcTracePath) await mkdir(path.dirname(rpcTracePath), { recursive: true });

	const engine = sandboxEngine ?? createMandatorySandboxEngine();
	const launch = await engine.launchWorker({
		command: "pi",
		args: buildWorkerArgs(model, thinkingLevel, tools, guestExtensionEntry),
		env,
		policy: {
			model,
			sandboxWorkspaceDir: cwd,
			workerOutputPath: outputPath,
			sandboxHomeDir: homeDir ?? null,
		},
	});
	const stderrChunks: string[] = [];
	launch.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

	const rpcState = createRpcState((line) => {
		if (!rpcTracePath) return;
		appendFile(rpcTracePath, `${line}\n`).catch(() => undefined);
	});
	const rl = createInterface({ input: launch.stdout });
	rl.on("line", rpcState.onLine);

	try {
		for (const prompt of prompts) {
			launch.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
			await withTimeout(rpcState.waitForAgentEnd(), caseTimeoutMs, `Case ${evalCase.id}`);
			if (rpcState.promptError) break;
		}
		launch.stdin.end();
		const closePromise = launch.waitForExit();

		const resultPromise = collectWorkerResult({
			outputPath,
			evalCase,
			dryRun,
			stderrChunks,
			promptError: rpcState.promptError,
		});
		const result = await resultPromise;
		const diagnostics = rpcState.diagnostics();
		attachRpcDiagnostics(result, diagnostics);
		await persistRpcDiagnostics(rpcDiagnosticsPath, diagnostics);
		try {
			await withTimeout(closePromise, shutdownTimeoutMs, `Case ${evalCase.id} shutdown`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push(`worker shutdown error: ${message}`);
			launch.kill();
			await closePromise.catch(() => undefined);
		}
		return result;
	} catch (error) {
		const diagnostics = rpcState.diagnostics();
		await persistRpcDiagnostics(rpcDiagnosticsPath, diagnostics);
		if (
			error instanceof Error &&
			error.message.includes(`Case ${evalCase.id}`) &&
			error.message.includes("timed out")
		) {
			throw new Error(`${error.message}${buildTimeoutDiagnosticsHint(diagnostics)}`, { cause: error });
		}
		throw error;
	} finally {
		rpcState.dispose();
		rl.close();
		await launch.cleanup();
		await rm(outputDir, { recursive: true, force: true });
	}
};
