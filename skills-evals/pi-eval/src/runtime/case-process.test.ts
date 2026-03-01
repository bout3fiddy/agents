import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvalCase, ModelSpec } from "../data/types.js";
import { runCaseProcess } from "./case-process.js";

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
    process.stderr.write("simulated stderr\\n");
    process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
    if (seenPrompts >= turns) {
      process.exit(0);
      return;
    }
  }
});
`;

const withFakePiOnPath = async (mode: "success" | "prompt_error", run: () => Promise<void>): Promise<void> => {
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

test("runCaseProcess collects worker output and stderr across turns", { concurrency: false }, async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-case-process-"));
	try {
		const evalCase = buildEvalCase();
		await withFakePiOnPath("success", async () => {
			const result = await runCaseProcess({
				evalCase,
				model: TEST_MODEL,
				agentDir: cwd,
				cwd,
				dryRun: false,
				thinkingLevel: "low",
				tools: ["read"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
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
				agentDir: cwd,
				cwd,
				dryRun: true,
				thinkingLevel: "low",
				tools: ["read"],
				extensionEntry: path.join(cwd, "index.ts"),
				bootstrapProfile: "full_payload",
				availableSkills: ["coding"],
				bootstrapManifestHash: "manifest",
				readDenyPaths: [],
			});
			assert.equal(result.errors.includes("prompt blocked"), true);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
