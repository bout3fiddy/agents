import assert from "node:assert/strict";
import test from "node:test";
import {
	GUEST_HOME_DIR,
	GUEST_OUTPUT_DIR,
	GUEST_WORKSPACE_DIR,
	hostPathToGuest,
	mapReadDenyPathsToGuest,
	normalizePosixRelative,
} from "../../src/runtime/guest-paths.js";

test("constants are defined", () => {
	assert.equal(GUEST_WORKSPACE_DIR, "/workspace");
	assert.equal(GUEST_HOME_DIR, "/home/sandbox");
	assert.equal(GUEST_OUTPUT_DIR, "/tmp/pi-eval-out");
});

test("normalizePosixRelative converts to forward slashes", () => {
	assert.equal(normalizePosixRelative("a/b/c"), "a/b/c");
});

test("hostPathToGuest maps workspace-relative paths", () => {
	const result = hostPathToGuest("/sandbox/ws/src/main.ts", "/sandbox/ws", GUEST_WORKSPACE_DIR);
	assert.equal(result, "/workspace/src/main.ts");
});

test("hostPathToGuest maps root to guest root", () => {
	const result = hostPathToGuest("/sandbox/ws", "/sandbox/ws", GUEST_WORKSPACE_DIR);
	assert.equal(result, "/workspace");
});

test("hostPathToGuest rejects paths outside root", () => {
	assert.throws(
		() => hostPathToGuest("/other/file.ts", "/sandbox/ws", GUEST_WORKSPACE_DIR),
		/outside sandbox workspace/,
	);
});

test("mapReadDenyPathsToGuest maps workspace paths", () => {
	const result = mapReadDenyPathsToGuest({
		readDenyPaths: ["src/secret"],
		sandboxWorkspaceDir: "/sandbox/ws",
	});
	assert.deepStrictEqual(result, ["/workspace/src/secret"]);
});

test("mapReadDenyPathsToGuest maps home paths", () => {
	const result = mapReadDenyPathsToGuest({
		readDenyPaths: ["/sandbox/home/.env"],
		sandboxWorkspaceDir: "/sandbox/ws",
		sandboxHomeDir: "/sandbox/home",
	});
	assert.deepStrictEqual(result, ["/home/sandbox/.env"]);
});

test("mapReadDenyPathsToGuest rejects paths outside both roots", () => {
	assert.throws(
		() =>
			mapReadDenyPathsToGuest({
				readDenyPaths: ["/etc/passwd"],
				sandboxWorkspaceDir: "/sandbox/ws",
			}),
		/resolves outside sandbox workspace\/home/,
	);
});
