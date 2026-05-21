import assert from "node:assert/strict";
import test from "node:test";
import { extractJson } from "../../src/judging/judge.js";

test("extractJson chooses the final judge-shaped object from noisy output", () => {
	const raw = [
		"{}",
		"Here is the final verdict:",
		JSON.stringify({
			pass: true,
			verdict: "ok",
			dimensions: [],
			variantVerdicts: [],
		}),
	].join("\n");

	assert.equal(JSON.parse(extractJson(raw)).verdict, "ok");
});

test("extractJson handles braces inside strings", () => {
	const raw = JSON.stringify({
		pass: false,
		verdict: "contains { brace } text",
		dimensions: [],
		variantVerdicts: [],
	});

	assert.equal(JSON.parse(extractJson(raw)).verdict, "contains { brace } text");
});
