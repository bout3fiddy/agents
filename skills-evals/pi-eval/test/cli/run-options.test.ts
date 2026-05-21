import assert from "node:assert/strict";
import test from "node:test";
import { resolveCaseParallelism } from "../../src/cli/run-options.js";

test("resolveCaseParallelism defaults to available workers capped at six", () => {
	assert.equal(resolveCaseParallelism({ availableWorkers: 12 }), 6);
	assert.equal(resolveCaseParallelism({ availableWorkers: 4 }), 4);
});

test("resolveCaseParallelism accepts env or flag values while keeping the hard cap", () => {
	assert.equal(resolveCaseParallelism({ envValue: "3", availableWorkers: 12 }), 3);
	assert.equal(resolveCaseParallelism({ envValue: "20", availableWorkers: 12 }), 6);
	assert.equal(resolveCaseParallelism({ flagValue: "2", envValue: "5", availableWorkers: 12 }), 2);
	assert.equal(resolveCaseParallelism({ flagValue: "20", availableWorkers: 12 }), 6);
});

test("resolveCaseParallelism rejects invalid flag values", () => {
	assert.throws(
		() => resolveCaseParallelism({ flagValue: "0", availableWorkers: 12 }),
		/--parallelism/,
	);
	assert.throws(
		() => resolveCaseParallelism({ flagValue: true, availableWorkers: 12 }),
		/--parallelism/,
	);
});
