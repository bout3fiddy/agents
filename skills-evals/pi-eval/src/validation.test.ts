import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseLimitFlag, parseStringFlag, resolveCasesPath } from "./validation.js";

test("parseStringFlag requires a value", () => {
	assert.equal(parseStringFlag("--model", "gpt-4"), "gpt-4");
	assert.equal(parseStringFlag("--model", undefined), undefined);
	assert.throws(() => parseStringFlag("--model", true), /--model/);
	assert.throws(() => parseStringFlag("--model", " "), /--model/);
});

test("parseLimitFlag enforces positive integers", () => {
	assert.equal(parseLimitFlag("3"), 3);
	assert.equal(parseLimitFlag(undefined), undefined);
	assert.throws(() => parseLimitFlag("0"), /--limit/);
	assert.throws(() => parseLimitFlag("-1"), /--limit/);
	assert.throws(() => parseLimitFlag("1.5"), /--limit/);
	assert.throws(() => parseLimitFlag(true), /--limit/);
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
