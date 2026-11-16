import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvalCase, ModelSpec } from "../../../src/data/types.js";
import { runCaseProcess } from "../../../src/runtime/case/case-process.js";
import type { SandboxEngine } from "../../../src/runtime/engine/sandbox-engine.js";

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

const FAKE_PI_SCRIPT =
	'#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = ' +
	'require("node:path");\n\nconst mode = process.env.FAKE_PI_MODE || ' +
	'"success";\nconst turns = Number.parseInt(process.env.PI_EVAL_TURN' +
	'S || "1", 10);\nconst outputPath = process.env.PI_EVAL_OUTPUT;\nco' +
	'nst caseId = process.env.PI_EVAL_CASE_ID || "unknown";\nconst dryR' +
	'un = process.env.PI_EVAL_DRY_RUN === "1";\nlet seenPrompts = 0;\nl' +
	"et written = false;\n\nconst writeResult = () => {\n  if (written ||" +
	" !outputPath) return;\n  fs.mkdirSync(path.dirname(outputPath), { re" +
	"cursive: true });\n  const payload = {\n    caseId,\n    dryRun,\n  " +
	'  model: null,\n    workerReady: true,\n    skillInvocations: ["exa' +
	'mple-skill"],\n    skillAttempts: ["example-skill"],\n    refInvo' +
	'cations: [],\n    refAttempts: [],\n    outputText: "worker complet' +
	'ed",\n    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: ' +
	"0, totalTokens: 3 },\n    durationMs: 5,\n    errors: []\n  };\n  fs" +
	".writeFileSync(outputPath, JSON.stringify(payload));\n  written = tr" +
	'ue;\n};\n\nprocess.stdin.setEncoding("utf8");\nlet buffer = "";' +
	'\nprocess.stdin.on("data", (chunk) => {\n  buffer += chunk;\n  whi' +
	'le (true) {\n    const newline = buffer.indexOf("\\n");\n    if (n' +
	"ewline === -1) break;\n    const line = buffer.slice(0, newline).tri" +
	"m();\n    buffer = buffer.slice(newline + 1);\n    if (!line) contin" +
	'ue;\n    seenPrompts += 1;\n    writeResult();\n    if (mode === "p' +
	'rompt_error") {\n      process.stdout.write(JSON.stringify({ type: ' +
	'"response", command: "prompt", success: false, error: "prompt b' +
	'locked" }) + "\\n");\n      process.stdout.write(JSON.stringify({' +
	' type: "agent_end" }) + "\\n");\n      process.exit(0);\n      r' +
	'eturn;\n    }\n\t    if (mode === "retry_terminal") {\n\t      pro' +
	'cess.stdout.write(\n\t        JSON.stringify({\n          type: "ag' +
	'ent_end",\n          messages: [{ role: "assistant", stopReason: ' +
	'"error", errorMessage: "terminated" }],\n        }) + "\\n",\n' +
	"      );\n      process.stdout.write(\n        JSON.stringify({\n   " +
	'       type: "auto_retry_start",\n          attempt: 1,\n         ' +
	" maxAttempts: 3,\n          delayMs: 2000,\n          errorMessage: " +
	'"terminated",\n        }) + "\\n",\n      );\n      process.stdo' +
	'ut.write(\n        JSON.stringify({\n          type: "auto_retry_en' +
	'd",\n          success: false,\n          attempt: 3,\n          fi' +
	'nalError: "terminated",\n        }) + "\\n",\n      );\n\t      ' +
	'process.exit(0);\n\t      return;\n\t    }\n\t    if (mode === "ret' +
	'ry_nonterminal_hangs") {\n\t      process.stdout.write(\n\t        ' +
	'JSON.stringify({\n\t          type: "agent_end",\n\t          mess' +
	'ages: [{ role: "assistant", stopReason: "error", errorMessage: ' +
	'"502 Bad Gateway\\n" }],\n\t        }) + "\\n",\n\t      );\n\t ' +
	"     process.stdout.write(\n\t        JSON.stringify({\n\t          " +
	'type: "auto_retry_start",\n\t          attempt: 1,\n\t          ma' +
	"xAttempts: 3,\n\t          delayMs: 2000,\n\t          errorMessage:" +
	' "502 Bad Gateway\\n",\n\t        }) + "\\n",\n\t      );\n\t   ' +
	"   setTimeout(() => process.exit(0), 600);\n\t      return;\n\t    }" +
	'\n\t    if (mode === "write_stream_incomplete") {\n\t      const w' +
	'riteToolId = "call_write_stream_incomplete_001";\n\t      process.' +
	'stdout.write(\n\t        JSON.stringify({\n\t          type: "messa' +
	'ge_update",\n\t          assistantMessageEvent: {\n\t            ty' +
	'pe: "toolcall_delta",\n\t            partial: {\n\t              r' +
	'ole: "assistant",\n\t              content: [\n\t                {' +
	'\n\t                  type: "toolCall",\n\t                  id: w' +
	'riteToolId,\n\t                  name: "write",\n\t               ' +
	'   partialJson: \'{"path":"/workspace/out.py","content":"def f' +
	"():\\n  return 1\\n',\n\t                },\n\t              ],\n\t " +
	'           },\n\t          },\n\t        }) + "\\n",\n\t      );\n' +
	"\t      process.stdout.write(\n\t        JSON.stringify({\n\t       " +
	'   type: "agent_end",\n\t          messages: [\n\t            {\n' +
	'\t              role: "assistant",\n\t              stopReason: "' +
	'error",\n\t              errorMessage: "terminated",\n\t         ' +
	'     content: [\n\t                {\n\t                  type: "to' +
	'olCall",\n\t                  id: writeToolId,\n\t                 ' +
	' name: "write",\n\t                  arguments: {\n\t             ' +
	'       path: "/workspace/out.py",\n\t                    content: ' +
	'"def f():\\n  return 1\\n",\n\t                  },\n\t           ' +
	"     },\n\t              ],\n\t            },\n\t          ],\n\t   " +
	'     }) + "\\n",\n\t      );\n\t      process.stdout.write(\n\t   ' +
	'     JSON.stringify({\n\t          type: "auto_retry_end",\n\t    ' +
	"      success: false,\n\t          attempt: 3,\n\t          finalErr" +
	'or: "terminated",\n\t        }) + "\\n",\n\t      );\n\t      pr' +
	"ocess.exit(0);\n\t      return;\n\t    }\n\t    process.stderr.write" +
	'("simulated stderr\\n");\n\t    process.stdout.write(JSON.stringif' +
	'y({ type: "agent_end" }) + "\\n");\n    if (seenPrompts >= turns' +
	") {\n      process.exit(0);\n      return;\n    }\n  }\n});\n";

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
				if (!proc.killed) {
					proc.kill();
				}
			},
			cleanup: async () => {
				if (!proc.killed) {
					proc.kill();
				}
			},
		};
	},
});

test(
	"runCaseProcess collects worker output and stderr across turns",
	{ concurrency: false },
	async () => {
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
					availableSkills: ["example-skill"],
					bootstrapManifestHash: "manifest",
					readDenyPaths: [],
					sandboxEngine: createHostSpawnSandboxEngine(),
				});
				assert.equal(result.caseId, evalCase.id);
				assert.equal(result.outputText, "worker completed");
				assert.equal(result.tokens.totalTokens, 3);
				assert.equal(
					result.errors.some((entry) => entry.includes("simulated stderr")),
					true,
				);
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"runCaseProcess appends prompt rejection errors from RPC stream",
	{ concurrency: false },
	async () => {
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
					availableSkills: ["example-skill"],
					bootstrapManifestHash: "manifest",
					readDenyPaths: [],
					sandboxEngine: createHostSpawnSandboxEngine(),
				});
				assert.equal(result.errors.includes("prompt blocked"), true);
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"runCaseProcess captures terminal auto-retry failures without shutdow" + "n timeout",
	{ concurrency: false },
	async () => {
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
					availableSkills: ["example-skill"],
					bootstrapManifestHash: "manifest",
					readDenyPaths: [],
					sandboxEngine: createHostSpawnSandboxEngine(),
				});
				assert.equal(result.errors.includes("terminated"), true);
				assert.equal(
					result.errors.some((entry) => entry.includes("shutdown timed out")),
					false,
				);
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"runCaseProcess treats non-terminal error agent_end as provisional wh" + "en auto-retry starts",
	{ concurrency: false },
	async () => {
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
							availableSkills: ["example-skill"],
							bootstrapManifestHash: "manifest",
							readDenyPaths: [],
							sandboxEngine: createHostSpawnSandboxEngine(),
						}),
					(error: unknown) =>
						error instanceof Error &&
						error.message.includes("Case CD-CASEPROC-004 timed out after 250ms"),
				);
			});
		} finally {
			if (originalCaseTimeout === undefined) {
				delete process.env.PI_EVAL_CASE_TIMEOUT_MS;
			} else {
				process.env.PI_EVAL_CASE_TIMEOUT_MS = originalCaseTimeout;
			}

			if (originalShutdownTimeout === undefined) {
				delete process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
			} else {
				process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout;
			}

			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"runCaseProcess records incomplete write tool-call diagnostics",
	{ concurrency: false },
	async () => {
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
					availableSkills: ["example-skill"],
					bootstrapManifestHash: "manifest",
					readDenyPaths: [],
					sandboxEngine: createHostSpawnSandboxEngine(),
				});
				assert.equal(result.errors.includes("terminated"), true);
				assert.equal(
					result.errors.some((entry) =>
						entry.includes("rpc diagnostics: incomplete tool call 'write'"),
					),
					true,
				);
				assert.equal(
					result.rpcDiagnostics?.toolCalls.some((call) => call.toolName === "write"),
					true,
				);
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"runCaseProcess persists rpc diagnostics when a case times out",
	{ concurrency: false },
	async () => {
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
							availableSkills: ["example-skill"],
							bootstrapManifestHash: "manifest",
							readDenyPaths: [],
							sandboxEngine: createHostSpawnSandboxEngine(),
						}),
					(error: unknown) =>
						error instanceof Error &&
						error.message.includes("Case CD-CASEPROC-006 timed out after 250ms"),
				);
			});
			const diagnosticsPath = path.join(traceDir, "CD-CASEPROC-006.diagnostics.json");
			const diagnosticsRaw = await readFile(diagnosticsPath, "utf-8");
			const diagnostics = JSON.parse(diagnosticsRaw) as {
				autoRetryStartCount?: number;
				eventCounts?: Record<string, number>;
			};
			assert.equal((diagnostics.autoRetryStartCount ?? 0) > 0, true);
			assert.equal((diagnostics.eventCounts?.agent_end ?? 0) > 0, true);
		} finally {
			if (originalCaseTimeout === undefined) {
				delete process.env.PI_EVAL_CASE_TIMEOUT_MS;
			} else {
				process.env.PI_EVAL_CASE_TIMEOUT_MS = originalCaseTimeout;
			}

			if (originalShutdownTimeout === undefined) {
				delete process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS;
			} else {
				process.env.PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout;
			}

			if (originalRpcTraceDir === undefined) {
				delete process.env.PI_EVAL_RPC_TRACE_DIR;
			} else {
				process.env.PI_EVAL_RPC_TRACE_DIR = originalRpcTraceDir;
			}

			await rm(traceDir, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
