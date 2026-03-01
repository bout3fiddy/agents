import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { assertManagedTempPath, toSafePathSegment } from "./path-safety.js";

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
