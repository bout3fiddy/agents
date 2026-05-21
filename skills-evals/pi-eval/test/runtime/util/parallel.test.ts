import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "../../../src/data/utils.js";
import { runItemsInParallel } from "../../../src/runtime/util/parallel.js";

test("runItemsInParallel preserves result order and caps active work", async () => {
	let active = 0;
	let maxActive = 0;

	const results = await runItemsInParallel([0, 1, 2, 3, 4], 2, async (item) => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await sleep(5);
		active -= 1;
		return item * 10;
	});

	assert.deepEqual(results, [0, 10, 20, 30, 40]);
	assert.equal(maxActive, 2);
});

test("runItemsInParallel treats non-positive parallelism as one worker", async () => {
	let active = 0;
	let maxActive = 0;

	await runItemsInParallel([0, 1, 2], 0, async () => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await sleep(5);
		active -= 1;
	});

	assert.equal(maxActive, 1);
});
