import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FORBIDDEN_READ_ERROR, assertReadablePath, createPathDenyPolicy } from "../../src/runtime/read-policy.js";
import {
	FORBIDDEN_WORKSPACE_VIOLATION,
	assertWithinSandboxBoundary,
	createSandboxBoundary,
	extractPathCandidates,
	wrapToolWithSandboxBoundary,
} from "../../src/runtime/sandbox-boundary.js";

test("assertReadablePath denies reads that match logical deny roots", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-deny-logical-"));
	const deniedDir = path.join(cwd, "skills");
	await mkdir(deniedDir, { recursive: true });
	const deniedFile = path.join(deniedDir, "SKILL.md");
	await writeFile(deniedFile, "deny");

	const policy = await createPathDenyPolicy(cwd, [deniedDir]);
	await assert.rejects(async () => assertReadablePath(deniedFile, policy), new RegExp(FORBIDDEN_READ_ERROR));
	await rm(cwd, { recursive: true, force: true });
});

test("assertReadablePath denies canonical paths that escape logical roots via symlink", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-deny-canonical-"));
	const forbiddenRoot = await mkdtemp(path.join(tmpdir(), "pi-eval-forbidden-root-"));
	const forbiddenDir = path.join(forbiddenRoot, "global");
	await mkdir(forbiddenDir, { recursive: true });
	const forbiddenFile = path.join(forbiddenDir, "SKILL.md");
	await writeFile(forbiddenFile, "deny");
	const link = path.join(cwd, "sandbox-link");
	await symlink(forbiddenDir, link, "dir");

	const allowedFile = path.join(cwd, "allowed.txt");
	await writeFile(allowedFile, "ok");
	const policy = await createPathDenyPolicy(cwd, [forbiddenRoot]);

	await assert.rejects(async () => assertReadablePath(path.join(link, "SKILL.md"), policy), new RegExp(FORBIDDEN_READ_ERROR));
	await assert.doesNotReject(async () => assertReadablePath(allowedFile, policy));
	await rm(cwd, { recursive: true, force: true });
	await rm(forbiddenRoot, { recursive: true, force: true });
});

test("extractPathCandidates returns only path-like argument fields", () => {
	const candidates = extractPathCandidates({
		path: "inside/file.txt",
		label: "ignore",
		nested: {
			filePath: "inside/other.txt",
			title: "ignore",
		},
		items: [
			{ target: "../escape.txt" },
			{ name: "ignore" },
		],
	});

	assert.deepEqual(
		new Set(candidates),
		new Set(["inside/file.txt", "inside/other.txt", "../escape.txt"]),
	);
});

test("assertWithinSandboxBoundary allows in-sandbox paths and denies traversal escape", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-boundary-"));
	const sandboxDir = path.join(cwd, "sandbox");
	await mkdir(sandboxDir, { recursive: true });

	const boundary = await createSandboxBoundary(cwd, sandboxDir);

	await assert.doesNotReject(() =>
		assertWithinSandboxBoundary(path.join("sandbox", "safe.txt"), boundary)
	);
	await assert.rejects(
		() => assertWithinSandboxBoundary(path.join("..", "escape.txt"), boundary),
		new RegExp(FORBIDDEN_WORKSPACE_VIOLATION),
	);
	assert.equal(boundary.violations.size, 1);

	await rm(cwd, { recursive: true, force: true });
});

test("assertWithinSandboxBoundary denies symlink escapes from sandbox", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-symlink-"));
	const sandboxDir = path.join(cwd, "sandbox");
	await mkdir(sandboxDir, { recursive: true });
	const outsideRoot = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-outside-"));
	const outsideFile = path.join(outsideRoot, "secret.txt");
	await writeFile(outsideFile, "secret");
	await symlink(outsideRoot, path.join(sandboxDir, "linked"), "dir");

	const boundary = await createSandboxBoundary(cwd, sandboxDir);

	await assert.rejects(
		() => assertWithinSandboxBoundary(path.join("sandbox", "linked", "secret.txt"), boundary),
		new RegExp(FORBIDDEN_WORKSPACE_VIOLATION),
	);
	assert.equal(boundary.violations.size, 1);

	await rm(cwd, { recursive: true, force: true });
	await rm(outsideRoot, { recursive: true, force: true });
});

test("assertWithinSandboxBoundary denies absolute paths outside sandbox root", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-absolute-"));
	const sandboxDir = path.join(cwd, "sandbox");
	await mkdir(sandboxDir, { recursive: true });
	const outsideRoot = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-absolute-outside-"));

	const boundary = await createSandboxBoundary(cwd, sandboxDir);
	const absoluteOutsidePath = path.join(outsideRoot, "secrets.txt");

	await assert.rejects(
		() => assertWithinSandboxBoundary(absoluteOutsidePath, boundary),
		new RegExp(FORBIDDEN_WORKSPACE_VIOLATION),
	);
	assert.equal(boundary.violations.size, 1);

	await rm(cwd, { recursive: true, force: true });
	await rm(outsideRoot, { recursive: true, force: true });
});

test("wrapToolWithSandboxBoundary blocks tool execution for out-of-sandbox write/edit paths", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-worker-wrap-"));
	const sandboxDir = path.join(cwd, "sandbox");
	await mkdir(sandboxDir, { recursive: true });
	const boundary = await createSandboxBoundary(cwd, sandboxDir);

	let executed = 0;
	const wrapped = wrapToolWithSandboxBoundary(
		{
			execute: async (_toolCallId: string, _args: Record<string, unknown>) => {
				executed += 1;
				return { ok: true };
			},
		},
		boundary,
	);

	await assert.doesNotReject(() =>
		wrapped.execute("ok", { filePath: path.join("sandbox", "allowed.txt"), content: "ok" })
	);
	assert.equal(executed, 1);

	await assert.rejects(
		() => wrapped.execute("bad", { filePath: path.join("..", "host.txt"), content: "nope" }),
		new RegExp(FORBIDDEN_WORKSPACE_VIOLATION),
	);
	assert.equal(executed, 1);

	await rm(cwd, { recursive: true, force: true });
});
