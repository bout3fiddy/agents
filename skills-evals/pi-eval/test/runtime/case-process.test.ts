import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvalCase, ModelSpec } from "../../src/data/types.js";
import { runCaseProcess } from "../../src/runtime/case-process.js";
import type { SandboxEngine } from "../../src/runtime/sandbox-engine.js";

const TEST_MODEL: ModelSpec = {
	provider: "openai",
	id: "gpt-5",
	key: "openai/gpt-5",
	label: "openai/gpt-5",
};

const buildEvalCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
	id: "CD-CASEPROC-001",
	suite: "pi-eval",
	prompt: "first prompt",
	turns: ["second prompt"],
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	...overrides,
});

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const mode = process.env.FAKE_PI_MODE || "success";
const turns = Number.parseInt(process.env.PI_EVAL_TURNS || "1", 10);
const outputPath = process.env.PI_EVAL_OUTPUT;
const caseId = process.env.PI_EVAL_CASE_ID || "unknown";
const dryRun = process.env.PI_EVAL_DRY_RUN === "1";
let seenPrompts = 0;
let written = false;

const writeResult = () => {
  if (written || !outputPath) return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const payload = {
    caseId,
    dryRun,
    model: null,
    workerReady: true,
    skillInvocations: ["coding"],
    skillAttempts: ["coding"],
    refInvocations: [],
    refAttempts: [],
    outputText: "worker completed",
    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    durationMs: 5,
    errors: []
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload));
  written = true;
};

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    seenPrompts += 1;
    writeResult();
    if (mode === "prompt_error") {
      process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: false, error: "prompt blocked" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
      process.exit(0);
      return;
    }
	    if (mode === "retry_terminal") {
	      process.stdout.write(
	        JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "error", errorMessage: "terminated" }],
        }) + "\\n",
      );
      process.stdout.write(
        JSON.stringify({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: "terminated",
        }) + "\\n",
      );
      process.stdout.write(
        JSON.stringify({
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: "terminated",
        }) + "\\n",
      );
	      process.exit(0);
	      return;
	    }
	    if (mode === "retry_nonterminal_hangs") {
	      process.stdout.write(
	        JSON.stringify({
	          type: "agent_end",
	          messages: [{ role: "assistant", stopReason: "error", errorMessage: "502 Bad Gateway\\n" }],
	        }) + "\\n",
	      );
	      process.stdout.write(
	        JSON.stringify({
	          type: "auto_retry_start",
	          attempt: 1,
	          maxAttempts: 3,
	          delayMs: 2000,
	          errorMessage: "502 Bad Gateway\\n",
	        }) + "\\n",
	      );
	      setTimeout(() => process.exit(0), 600);
	      return;
	    }
	    if (mode === "write_stream_incomplete") {
	      const writeToolId = "call_write_stream_incomplete_001";
	      process.stdout.write(
	        JSON.stringify({
	          type: "message_update",
	          assistantMessageEvent: {
	            type: "toolcall_delta",
	            partial: {
	              role: "assistant",
	              content: [
	                {
	                  type: "toolCall",
	                  id: writeToolId,
	                  name: "write",
	                  partialJson: '{"path":"/workspace/out.py","content":"def f():\\n  return 1\\n',
	                },
	              ],
	            },
	          },
	        }) + "\\n",
	      );
	      process.stdout.write(
	        JSON.stringify({
	          type: "agent_end",
	          messages: [
	            {
	              role: "assistant",
	              stopReason: "error",
	              errorMessage: "terminated",
	              content: [
	                {
	                  type: "toolCall",
	                  id: writeToolId,
	                  name: "write",
	                  arguments: {
	                    path: "/workspace/out.py",
	                    content: "def f():\\n  return 1\\n",
	                  },
	                },
	              ],
	            },
	          ],
	        }) + "\\n",
	      );
	      process.stdout.write(
	        JSON.stringify({
	          type: "auto_retry_end",
	          success: false,
	          attempt: 3,
	          finalError: "terminated",
	        }) + "\\n",
	      );
	      process.exit(0);
	      return;
	    }
	    process.stderr.write("simulated stderr\\n");
	    process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
    if (seenPrompts >= turns) {
      process.exit(0);
      return;
    }
  }
});
`;

const withFakePiOnPath = async (
	mode:
		| "success"
		| "prompt_error"
		| "retry_terminal"
		| "retry_nonterminal_hangs"
		| "write_stream_incomplete",
	run: () => Promise<void>,
): Promise<void> => {
	const fakeBinDir = await mkdtemp(path.join(tmpdir(), "pi-eval-fake-pi-"));
	const originalPath = process.env.PATH ?? "";
	const originalMode = process.env.FAKE_PI_MODE;
	try {
		const scriptPath = path.join(fakeBinDir, "pi");
		await writeFile(scriptPath, FAKE_PI_SCRIPT, "utf-8");
		await chmod(scriptPath, 0o755);
		process.env.PATH = `${fakeBinDir}:${originalPath}`;
		process.env.FAKE_PI_MODE = mode;
		await run();
	} finally {
		if (originalMode === undefined) {
			delete process.env.FAKE_PI_MODE;
		} else {
			process.env.FAKE_PI_MODE = originalMode;
		}
		process.env.PATH = originalPath;
		await rm(fakeBinDir, { recursive: true, force: true });
	}
};

const createHostSpawnSandboxEngine = (): SandboxEngine => ({
	launchWorker: async (request) => {
		const env = {
			...request.env,
			PI_EVAL_OUTPUT: request.policy.workerOutputPath,
			HOME: request.policy.sandboxHomeDir ?? request.policy.sandboxWorkspaceDir,
		};
		const proc = spawn(request.command, request.args, {
			cwd: request.policy.sandboxWorkspaceDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const waitForExit = () =>
			new Promise<number>((resolve, reject) => {
				proc.on("close", (code) => resolve(code ?? 0));
				proc.on("error", (error) => reject(error));
			});
		return {
			stdin: proc.stdin,
			stdout: proc.stdout,
			stderr: proc.stderr,
			waitForExit,
			kill: () => {
				if (!proc.killed) proc.kill();
			},
			cleanup: async () => {
				if (!proc.killed) proc.kill();
			},
		};
	},
});

test("runCaseProcess collects worker output and stderr across turns", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-"));
	try {
		const evalCase = buildEvalCase();
		await withFakePiOnPath("success", async () => {
			const result = await runCaseProcess({
				evalCase,
				model: TEST_MODEL,
				cwd,
				dryRun: false,
				thinkingLevel: "low",
				tools: ["read"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
				sandboxEngine: createHostSpawnSandboxEngine(),
			});
			assert.equal(result.caseId, evalCase.id);
			assert.equal(result.outputText, "worker completed");
			assert.equal(result.tokens.totalTokens, 3);
			assert.equal(result.errors.some((entry) => entry.includes("simulated stderr")), true);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runCaseProcess appends prompt rejection errors from RPC stream", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-prompt-"));
	try {
		const evalCase = buildEvalCase({ id: "CD-CASEPROC-002" });
		await withFakePiOnPath("prompt_error", async () => {
			const result = await runCaseProcess({
				evalCase,
				model: TEST_MODEL,
				cwd,
				dryRun: true,
				thinkingLevel: "low",
				tools: ["read"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
				sandboxEngine: createHostSpawnSandboxEngine(),
			});
			assert.equal(result.errors.includes("prompt blocked"), true);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runCaseProcess captures terminal auto-retry failures without shutdown timeout", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-retry-terminal-"));
	try {
		const evalCase = buildEvalCase({ id: "CD-CASEPROC-003", turns: [] });
		await withFakePiOnPath("retry_terminal", async () => {
			const result = await runCaseProcess({
				evalCase,
				model: TEST_MODEL,
				cwd,
				dryRun: false,
				thinkingLevel: "low",
				tools: ["read"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
				sandboxEngine: createHostSpawnSandboxEngine(),
			});
			assert.equal(result.errors.includes("terminated"), true);
			assert.equal(result.errors.some((entry) => entry.includes("shutdown timed out")), false);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runCaseProcess treats non-terminal error agent_end as provisional when auto-retry starts", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-retry-nonterminal-"));
	const originalCaseTimeout = process.env.PI_EVAL_CASE_TIMEOUT_MS;
	const originalShutdownTimeout = process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
	process.env.PI_EVAL_CASE_TIMEOUT_MS = "250";
	process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = "100";
	try {
		const evalCase = buildEvalCase({ id: "CD-CASEPROC-004", turns: [] });
		await withFakePiOnPath("retry_nonterminal_hangs", async () => {
			await assert.rejects(
				() =>
					runCaseProcess({
						evalCase,
						model: TEST_MODEL,
						cwd,
						dryRun: false,
						thinkingLevel: "low",
						tools: ["read"],
						extensionEntry: path.join(cwd, "index.ts"),
						bootstrapProfile: "full_payload",
						availableSkills: ["coding"],
						bootstrapManifestHash: "manifest",
						readDenyPaths: [],
						sandboxEngine: createHostSpawnSandboxEngine(),
					}),
				(error: unknown) =>
					error instanceof Error && error.message.includes("Case CD-CASEPROC-004 timed out after 250ms"),
			);
		});
	} finally {
		if (originalCaseTimeout === undefined) delete process.env.PI_EVAL_CASE_TIMEOUT_MS;
		else process.env.PI_EVAL_CASE_TIMEOUT_MS = originalCaseTimeout;
		if (originalShutdownTimeout === undefined) delete process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
		else process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runCaseProcess records incomplete write tool-call diagnostics", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-write-stream-incomplete-"));
	try {
		const evalCase = buildEvalCase({ id: "CD-CASEPROC-005", turns: [] });
		await withFakePiOnPath("write_stream_incomplete", async () => {
			const result = await runCaseProcess({
				evalCase,
				model: TEST_MODEL,
				cwd,
				dryRun: false,
				thinkingLevel: "low",
				tools: ["read", "write"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
				sandboxEngine: createHostSpawnSandboxEngine(),
			});
			assert.equal(result.errors.includes("terminated"), true);
			assert.equal(
				result.errors.some((entry) => entry.includes("rpc diagnostics: incomplete tool call 'write'")),
				true,
			);
			assert.equal(result.rpcDiagnostics?.toolCalls.some((call) => call.toolName === "write"), true);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runCaseProcess persists rpc diagnostics when a case times out", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-timeout-diag-"));
	const traceDir = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-timeout-trace-"));
	const originalCaseTimeout = process.env.PI_EVAL_CASE_TIMEOUT_MS;
	const originalShutdownTimeout = process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
	const originalRpcTraceDir = process.env.PI_EVAL_RPC_TRACE_DIR;
	process.env.PI_EVAL_CASE_TIMEOUT_MS = "250";
	process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = "100";
	process.env.PI_EVAL_RPC_TRACE_DIR = traceDir;
	try {
		const evalCase = buildEvalCase({ id: "CD-CASEPROC-006", turns: [] });
		await withFakePiOnPath("retry_nonterminal_hangs", async () => {
			await assert.rejects(
				() =>
					runCaseProcess({
						evalCase,
						model: TEST_MODEL,
						cwd,
						dryRun: false,
						thinkingLevel: "low",
						tools: ["read"],
						extensionEntry: path.join(cwd, "index.ts"),
						bootstrapProfile: "full_payload",
						availableSkills: ["coding"],
						bootstrapManifestHash: "manifest",
						readDenyPaths: [],
						sandboxEngine: createHostSpawnSandboxEngine(),
					}),
				(error: unknown) =>
					error instanceof Error && error.message.includes("Case CD-CASEPROC-006 timed out after 250ms"),
			);
		});
		const diagnosticsPath = path.join(traceDir, "CD-CASEPROC-006.diagnostics.json");
		const diagnosticsRaw = await readFile(diagnosticsPath, "utf-8");
		const diagnostics = JSON.parse(diagnosticsRaw) as { autoRetryStartCount?: number; eventCounts?: Record<string, number> };
		assert.equal((diagnostics.autoRetryStartCount ?? 0) > 0, true);
		assert.equal((diagnostics.eventCounts?.agent_end ?? 0) > 0, true);
	} finally {
		if (originalCaseTimeout === undefined) delete process.env.PI_EVAL_CASE_TIMEOUT_MS;
		else process.env.PI_EVAL_CASE_TIMEOUT_MS = originalCaseTimeout;
		if (originalShutdownTimeout === undefined) delete process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
		else process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout;
		if (originalRpcTraceDir === undefined) delete process.env.PI_EVAL_RPC_TRACE_DIR;
		else process.env.PI_EVAL_RPC_TRACE_DIR = originalRpcTraceDir;
		await rm(traceDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});
