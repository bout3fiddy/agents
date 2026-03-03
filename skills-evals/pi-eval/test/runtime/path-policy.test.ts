import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { assertManagedTempPath, resolveCanonicalPath, toSafePathSegment } from "../../src/runtime/path-policy.js";

test("toSafePathSegment strips traversal and absolute-path characters", () => {
	assert.equal(toSafePathSegment("../../etc/passwd"), "etc-passwd");
	assert.equal(toSafePathSegment("/tmp/evil"), "tmp-evil");
	assert.equal(toSafePathSegment("   "), "case");
});

test("assertManagedTempPath allows nested managed paths", () => {
	const root = path.join(tmpdir(), "pi-eval-home");
	const candidate = path.join(root, "CD-015", "abc123");
	assert.equal(assertManagedTempPath(candidate, root, "home cleanup"), candidate);
});

test("assertManagedTempPath rejects outside and shallow paths", () => {
	const root = path.join(tmpdir(), "pi-eval-home");
	assert.throws(
		() => assertManagedTempPath(path.join(tmpdir(), "outside-dir"), root, "home cleanup"),
		/outside managed cleanup root/i,
	);
	assert.throws(
		() => assertManagedTempPath(path.join(root, "CD-015"), root, "home cleanup"),
		/too shallow/i,
	);
});

// ── resolveCanonicalPath ────────────────────────────────────────────────

test("resolveCanonicalPath resolves existing paths", async () => {
	const result = await resolveCanonicalPath(tmpdir());
	assert.ok(result);
	assert.ok(path.isAbsolute(result));
});

test("resolveCanonicalPath uses cache on second call", async () => {
	const cache = new Map<string, string | null>();
	const dir = tmpdir();
	const result1 = await resolveCanonicalPath(dir, cache);
	assert.ok(cache.has(dir));
	const result2 = await resolveCanonicalPath(dir, cache);
	assert.equal(result1, result2);
});

test("resolveCanonicalPath parent-walks for non-existent paths", async () => {
	const nonExistent = path.join(tmpdir(), "does-not-exist-" + Date.now(), "child");
	const result = await resolveCanonicalPath(nonExistent);
	// Should resolve to something based on the existing parent (tmpdir)
	assert.ok(result);
	assert.ok(result.includes("does-not-exist"));
});
