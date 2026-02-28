import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import type { EvalCase } from "../data/types.js";
import { fileExists } from "../data/utils.js";
import {
	buildProfileReadDenyPaths,
	collectPolicyDenyProbeErrors,
	hardenNoPayloadWorkspace,
} from "./case-lifecycle.js";

const buildEvalCase = (bootstrapProfile: "full_payload" | "no_payload" = "full_payload"): EvalCase => ({
	id: "CD-015-NS-UT",
	suite: "pi-eval",
	prompt: "Audit sandbox deny paths.",
	expectedSkills: [],
	disallowedSkills: [],
	expectedRefs: [],
	bootstrapProfile,
});

test("buildProfileReadDenyPaths hardens no-payload with workspace, home, and host home skill surfaces", async () => {
	const workspaceAgentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-workspace-"));
	const homeDir = await mkdtemp(path.join(tmpdir(), "pi-eval-home-"));
	const hostWorkspaceDir = process.cwd();

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
		path.join(homeDir, ".agents"),
		path.join(homeDir, ".codex"),
		path.join(homeDir, ".codex", "skills"),
		path.join(homeDir, ".pi"),
		path.join(hostWorkspaceDir, "skills"),
		path.join(hostWorkspaceDir, "instructions"),
		path.join(hostWorkspaceDir, ".agents"),
		path.join(hostWorkspaceDir, ".codex"),
		path.join(hostWorkspaceDir, ".pi"),
		path.join(homedir(), ".agents"),
		path.join(homedir(), ".codex"),
		path.join(homedir(), ".codex", "skills"),
		path.join(homedir(), ".pi"),
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
		path.join(workspaceAgentDir, "keepme"),
	];

	for (const target of blocklisted) {
		await mkdir(target, { recursive: true });
		await writeFile(path.join(target, "probe.txt"), "probe");
	}

	await hardenNoPayloadWorkspace(workspaceAgentDir);

	for (const target of blocklisted.slice(0, 5)) {
		assert.equal(await fileExists(target), false, `expected removed path: ${target}`);
	}
	assert.equal(await fileExists(blocklisted[5]), true, "non-blocklisted path should remain");

	await rm(workspaceAgentDir, { recursive: true, force: true });
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
