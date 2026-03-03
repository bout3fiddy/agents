import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertAllowedFlags,
	resolveCasesPath,
} from "../../src/cli/validation.js";

test("assertAllowedFlags rejects unknown flags", () => {
	assert.doesNotThrow(() =>
		assertAllowedFlags(
			{
				"--model": "gpt-5",
				"--dry-run": true,
			},
			["--model", "--dry-run"],
		)
	);
	assert.throws(
		() => assertAllowedFlags({ "--model": "gpt-5", "--skill": "coding" }, ["--model"]),
		/Unknown flag\(s\): --skill/,
	);
});

test("resolveCasesPath checks for existing files", async () => {
	const dir = path.join(tmpdir(), `pi-eval-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "cases.jsonl");
	await writeFile(filePath, "{}\n");

	const resolved = await resolveCasesPath(dir, "cases.jsonl", "default.jsonl");
	assert.equal(resolved, filePath);

	await assert.rejects(
		() => resolveCasesPath(dir, "missing.jsonl", "default.jsonl"),
		/Cases file not found/,
	);
	await assert.rejects(
		() => resolveCasesPath(dir, true, "default.jsonl"),
		/--cases/,
	);

	await rm(dir, { recursive: true, force: true });
});
