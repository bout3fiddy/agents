import assert from "node:assert/strict";
import test from "node:test";
import { extractJson } from "../../src/judging/judge.js";

test("extractJson chooses the final judge-shaped object from noisy output", () => {
	const raw = [
		"{}",
		"Here is the final verdict:",
		JSON.stringify({
			pass: true,
			reportMarkdown: "ok",
			cases: [],
		}),
	].join("\n");

	assert.equal(JSON.parse(extractJson(raw)).reportMarkdown, "ok");
});

test("extractJson handles braces inside strings", () => {
	const raw = JSON.stringify({
		pass: false,
		reportMarkdown: "contains { brace } text",
		cases: [],
	});

	assert.equal(JSON.parse(extractJson(raw)).reportMarkdown, "contains { brace } text");
});
