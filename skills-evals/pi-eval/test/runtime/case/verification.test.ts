import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runVerificationCommands } from "../../../src/runtime/case/verification.js";

test("runVerificationCommands captures output and reports failed commands", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-eval-verification-"));
	try {
		const { results, errors } = await runVerificationCommands([
			{
				label: "passing command",
				argv: ["node", "-e", "console.log('ok')"],
				timeoutMs: 10_000,
			},
			{
				label: "failing command",
				argv: ["node", "-e", "process.exit(7)"],
				timeoutMs: 10_000,
			},
		], cwd);

		assert.equal(results.length, 2);
		assert.equal(results[0].exitCode, 0);
		assert.match(results[0].stdout, /ok/);
		assert.equal(results[1].exitCode, 7);
		assert.equal(errors.some((entry) => entry.includes("verification 'failing command' failed")), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
