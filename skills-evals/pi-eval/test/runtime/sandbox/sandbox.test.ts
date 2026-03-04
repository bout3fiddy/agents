import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	cleanupSandbox,
	cleanupSandboxHome,
	createSandbox,
	createSandboxHome,
} from "../../../src/runtime/sandbox/sandbox.js";

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
		const fixturePath = path.join(agentDir, "skills-evals", "fixtures", "probe.txt");
		const extensionEntryPath = path.join(agentDir, "skills-evals", "pi-eval", "index.ts");
		const workerEntryPath = path.join(agentDir, "skills-evals", "pi-eval", "worker.ts");
		const runtimePath = path.join(agentDir, "skills-evals", "pi-eval", "src", "index.ts");
		await mkdir(path.dirname(fixturePath), { recursive: true });
		await mkdir(path.dirname(extensionEntryPath), { recursive: true });
		await mkdir(path.dirname(workerEntryPath), { recursive: true });
		await mkdir(path.dirname(runtimePath), { recursive: true });
		await writeFile(fixturePath, "fixture", "utf-8");
		await writeFile(extensionEntryPath, "export default () => {};\n", "utf-8");
		await writeFile(workerEntryPath, "export default () => {};\n", "utf-8");
		await writeFile(runtimePath, "export {};\n", "utf-8");
		await writeFile(path.join(agentDir, "AGENTS.md"), "# Agent instructions", "utf-8");
		sandboxDir = await createSandbox(agentDir, "../../../../../etc/passwd");
		homeDir = await createSandboxHome("/tmp/../../evil");

		assert.equal(isInsideRoot(sandboxDir, sandboxRoot), true);
		assert.equal(isInsideRoot(homeDir, homeRoot), true);
		assert.equal(sandboxDir.includes(".."), false);
		assert.equal(homeDir.includes(".."), false);
		const sandboxFixture = await readFile(
			path.join(sandboxDir, "skills-evals", "fixtures", "probe.txt"),
			"utf-8",
		);
		const sandboxEntry = await readFile(
			path.join(sandboxDir, "skills-evals", "pi-eval", "index.ts"),
			"utf-8",
		);
		const sandboxWorkerEntry = await readFile(
			path.join(sandboxDir, "skills-evals", "pi-eval", "worker.ts"),
			"utf-8",
		);
		const sandboxRuntime = await readFile(
			path.join(sandboxDir, "skills-evals", "pi-eval", "src", "index.ts"),
			"utf-8",
		);
		assert.match(sandboxFixture, /fixture/);
		assert.match(sandboxEntry, /export default/);
		assert.match(sandboxWorkerEntry, /export default/);
		assert.match(sandboxRuntime, /export/);
		await assert.rejects(
			() => readFile(path.join(sandboxDir, "AGENTS.md"), "utf-8"),
			/ENOENT/,
		);
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
