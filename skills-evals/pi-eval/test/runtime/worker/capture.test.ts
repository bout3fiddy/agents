import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	captureReadAttempt,
	captureReadDenied,
	captureReadInvocation,
	serializeReadCapture,
	type ReadCapture,
} from "../../../src/runtime/worker/capture.js";

const createReadCapture = (): ReadCapture => ({
	skillAttempts: new Set<string>(),
	skillInvocations: new Set<string>(),
	skillDenied: new Set<string>(),
	skillFileAttempts: new Set<string>(),
	skillFileInvocations: new Set<string>(),
	skillFileDenied: new Set<string>(),
	refAttempts: new Set<string>(),
	refInvocations: new Set<string>(),
	refDenied: new Set<string>(),
	readSizes: new Map<string, number>(),
});

test("captureRead tracks attempted, successful, and denied reference reads" + " separately", () => {
	const agentDir = path.join(path.sep, "tmp", "pi-eval-agent");
	const refPath = path.join(
		agentDir,
		"skills",
		"example-skill",
		"references",
		"code-smells",
		"index.md",
	);
	const capture = createReadCapture();

	captureReadAttempt(refPath, agentDir, capture);
	captureReadInvocation(refPath, agentDir, capture);
	captureReadDenied(refPath, agentDir, capture);

	const serialized = serializeReadCapture(capture);
	assert.deepEqual(serialized.skillAttempts, ["example-skill"]);
	assert.deepEqual(serialized.skillInvocations, ["example-skill"]);
	assert.deepEqual(serialized.skillDenied, ["example-skill"]);
	assert.deepEqual(serialized.refAttempts, [
		"skills/example-skill/references/code-smells/index.md",
	]);
	assert.deepEqual(serialized.refInvocations, [
		"skills/example-skill/references/code-smells/index.md",
	]);
	assert.deepEqual(serialized.refDenied, ["skills/example-skill/references/code-smells/index.md"]);
});

test("captureRead normalizes host .agents skill references to canonical sk" + "ills paths", () => {
	const agentDir = path.join(path.sep, "tmp", "pi-eval-agent");
	const hostRef = path.join(
		path.sep,
		"Users",
		"example-user",
		".agents",
		"skills",
		"example-skill",
		"references",
		"bun.md",
	);
	const capture = createReadCapture();

	captureReadDenied(hostRef, agentDir, capture);

	const serialized = serializeReadCapture(capture);
	assert.deepEqual(serialized.refDenied, ["skills/example-skill/references/bun.md"]);
	assert.deepEqual(serialized.skillDenied, ["example-skill"]);
});

test("captureRead preserves absolute host paths that are not skill references", () => {
	const agentDir = path.join(path.sep, "tmp", "pi-eval-agent");
	const hostRef = path.join(path.sep, "tmp", "pi-eval-host-read-marker.txt");
	const capture = createReadCapture();

	captureReadDenied(hostRef, agentDir, capture);

	const serialized = serializeReadCapture(capture);
	assert.deepEqual(serialized.refDenied, []);
	assert.deepEqual(serialized.skillDenied, []);
});
