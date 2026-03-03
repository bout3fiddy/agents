import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvalCase } from "../../src/data/types.js";
import { fileExists } from "../../src/data/utils.js";
import {
	buildProfileReadDenyPaths,
	collectPolicyDenyProbeErrors,
	hardenNoPayloadWorkspace,
	mirrorBootstrapPayloadToWorkspace,
	resolveSandboxExtensionEntry,
} from "../../src/runtime/case-lifecycle.js";

const buildEvalCase = (bootstrapProfile: "full_payload" | "no_payload" = "full_payload"): EvalCase => ({
	id: "CD-015-NS-UT",
	suite: "pi-eval",
	prompt: "Audit sandbox deny paths.",
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	bootstrapProfile,
});

test("buildProfileReadDenyPaths hardens no-payload with workspace and sandbox-home skill surfaces", async () => {
	const workspaceAgentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-workspace-"));
	const homeDir = await mkdtemp(path.join(tmpdir(), "pi-eval-home-"));

	const denyPaths = buildProfileReadDenyPaths({
		evalCase: buildEvalCase("no_payload"),
		workspaceAgentDir,
		homeDir,
		bootstrapProfile: "no_payload",
	});

	const expected = [
		path.join(workspaceAgentDir, "skills"),
		path.join(workspaceAgentDir, "instructions"),
		path.join(workspaceAgentDir, ".agents"),
		path.join(workspaceAgentDir, ".codex"),
		path.join(workspaceAgentDir, ".pi"),
		path.join(workspaceAgentDir, "AGENTS.md"),
			path.join(homeDir, ".agents"),
			path.join(homeDir, ".codex"),
			path.join(homeDir, ".codex", "skills"),
			path.join(homeDir, ".pi"),
		];
	for (const expectedPath of expected) {
		assert.ok(denyPaths.includes(expectedPath), `missing deny path: ${expectedPath}`);
	}

	await rm(workspaceAgentDir, { recursive: true, force: true });
	await rm(homeDir, { recursive: true, force: true });
});

test("buildProfileReadDenyPaths does not inject no-payload-specific blocks into full payload", async () => {
	const workspaceAgentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-workspace-full-"));
	const homeDir = await mkdtemp(path.join(tmpdir(), "pi-eval-home-full-"));

	const denyPaths = buildProfileReadDenyPaths({
		evalCase: buildEvalCase("full_payload"),
		workspaceAgentDir,
		homeDir,
		bootstrapProfile: "full_payload",
	});

	const forbiddenForNoPayload = [
		path.join(workspaceAgentDir, "skills"),
		path.join(workspaceAgentDir, "instructions"),
		path.join(workspaceAgentDir, ".agents"),
		path.join(workspaceAgentDir, ".codex"),
		path.join(workspaceAgentDir, ".pi"),
		path.join(workspaceAgentDir, "AGENTS.md"),
		path.join(homeDir, ".agents"),
		path.join(homeDir, ".codex"),
		path.join(homeDir, ".codex", "skills"),
		path.join(homeDir, ".pi"),
	];
	for (const blocked of forbiddenForNoPayload) {
		assert.ok(!denyPaths.includes(blocked), `unexpected no-payload deny path in full payload: ${blocked}`);
	}

	await rm(workspaceAgentDir, { recursive: true, force: true });
	await rm(homeDir, { recursive: true, force: true });
});

test("hardenNoPayloadWorkspace removes blocklisted skill and directive paths", async () => {
	const workspaceAgentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-harden-"));
	const blocklisted = [
		path.join(workspaceAgentDir, "skills"),
		path.join(workspaceAgentDir, "instructions"),
		path.join(workspaceAgentDir, ".agents"),
		path.join(workspaceAgentDir, ".codex"),
		path.join(workspaceAgentDir, ".pi"),
		path.join(workspaceAgentDir, "AGENTS.md"),
		path.join(workspaceAgentDir, "keepme"),
	];

	for (const target of blocklisted) {
		await mkdir(target, { recursive: true });
		await writeFile(path.join(target, "probe.txt"), "probe");
	}

	await hardenNoPayloadWorkspace(workspaceAgentDir);

	for (const target of blocklisted.slice(0, 6)) {
		assert.equal(await fileExists(target), false, `expected removed path: ${target}`);
	}
	assert.equal(await fileExists(blocklisted[6]), true, "non-blocklisted path should remain");

	await rm(workspaceAgentDir, { recursive: true, force: true });
});

test("mirrorBootstrapPayloadToWorkspace projects synced bootstrap files into workspace root paths", async () => {
	const workspaceAgentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-workspace-bootstrap-"));
	const homeDir = await mkdtemp(path.join(tmpdir(), "pi-eval-home-bootstrap-"));
	try {
		await mkdir(path.join(homeDir, ".agents", "skills", "coding"), { recursive: true });
		await writeFile(path.join(homeDir, ".agents", "AGENTS.md"), "# sandbox instructions\n", "utf-8");
		await writeFile(path.join(homeDir, ".agents", "skills.router.min.json"), "{\"schema_version\":\"1\"}\n", "utf-8");
		await writeFile(path.join(homeDir, ".agents", "skills", "coding", "SKILL.md"), "# coding skill\n", "utf-8");

		await mirrorBootstrapPayloadToWorkspace({
			workspaceAgentDir,
			homeDir,
		});

		assert.equal(await fileExists(path.join(workspaceAgentDir, "AGENTS.md")), true);
		assert.equal(
			await fileExists(path.join(workspaceAgentDir, "instructions", "skills.router.min.json")),
			true,
		);
		assert.equal(
			await fileExists(path.join(workspaceAgentDir, "skills", "coding", "SKILL.md")),
			true,
		);
	} finally {
		await rm(workspaceAgentDir, { recursive: true, force: true });
		await rm(homeDir, { recursive: true, force: true });
	}
});

test("collectPolicyDenyProbeErrors emits forbidden read evidence for must_trigger_policy_deny assertions", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-probe-"));
	const denyRoot = path.join(cwd, "skills");
	const probeErrors = await collectPolicyDenyProbeErrors({
		cwd,
		readDenyPaths: [denyRoot],
		assertions: ["must_trigger_policy_deny:skills/coding/SKILL.md"],
	});

	assert.equal(probeErrors.length, 1);
	assert.match(probeErrors[0] ?? "", /forbidden read:/);
	assert.match(probeErrors[0] ?? "", /skills\/coding\/SKILL\.md$/);

	await rm(cwd, { recursive: true, force: true });
});

test("resolveSandboxExtensionEntry remaps host extension paths into sandbox workspace", () => {
	const mapped = resolveSandboxExtensionEntry({
		hostExtensionEntry: "/Users/example/agents/skills-evals/pi-eval/index.ts",
		hostAgentDir: "/Users/example/agents",
		sandboxAgentDir: "/tmp/pi-eval-sandbox/workspace",
	});
	assert.equal(mapped, "/tmp/pi-eval-sandbox/workspace/skills-evals/pi-eval/index.ts");
});

test("resolveSandboxExtensionEntry rejects extension paths outside the host agent dir", () => {
	assert.throws(
		() =>
			resolveSandboxExtensionEntry({
				hostExtensionEntry: "/Users/example/other/index.ts",
				hostAgentDir: "/Users/example/agents",
				sandboxAgentDir: "/tmp/pi-eval-sandbox/workspace",
			}),
		/inside agent dir/,
	);
});
