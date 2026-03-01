import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	cleanupSandbox,
	cleanupSandboxHome,
	createSandbox,
	createSandboxHome,
} from "./sandbox.js";

const isInsideRoot = (candidate: string, root: string): boolean => {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

test("createSandbox and createSandboxHome sanitize case IDs and stay under managed tmp roots", async () => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-eval-agent-src-"));
	const sandboxRoot = path.join(tmpdir(), "pi-eval-sandbox");
	const homeRoot = path.join(tmpdir(), "pi-eval-home");
	let sandboxDir: string | null = null;
	let homeDir: string | null = null;
	try {
		await writeFile(path.join(agentDir, "probe.txt"), "probe");
		sandboxDir = await createSandbox(agentDir, "../../../../../etc/passwd");
		homeDir = await createSandboxHome("/tmp/../../evil");

		assert.equal(isInsideRoot(sandboxDir, sandboxRoot), true);
		assert.equal(isInsideRoot(homeDir, homeRoot), true);
		assert.equal(sandboxDir.includes(".."), false);
		assert.equal(homeDir.includes(".."), false);
	} finally {
		await cleanupSandbox(sandboxDir);
		await cleanupSandboxHome(homeDir);
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("cleanupSandbox and cleanupSandboxHome reject unmanaged paths", async () => {
	const outsideSandbox = await mkdtemp(path.join(tmpdir(), "outside-sandbox-"));
	const outsideHome = await mkdtemp(path.join(tmpdir(), "outside-home-"));
	try {
		await assert.rejects(
			() => cleanupSandbox(outsideSandbox),
			/outside managed cleanup root/i,
		);
		await assert.rejects(
			() => cleanupSandboxHome(outsideHome),
			/outside managed cleanup root/i,
		);
	} finally {
		await rm(outsideSandbox, { recursive: true, force: true });
		await rm(outsideHome, { recursive: true, force: true });
	}
});
