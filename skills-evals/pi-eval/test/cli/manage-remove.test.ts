import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { resolveRemoveTargets, executeRemove, type RemoveDirs } from "../../src/cli/manage-remove.js";

const makeTmpDirs = (): { root: string; dirs: RemoveDirs; cleanup: () => void } => {
	const root = path.join(os.tmpdir(), `manage-remove-test-${Date.now()}`);
	const dirs: RemoveDirs = {
		casesDir: path.join(root, "cases"),
		reportsDir: path.join(root, "reports"),
		generatedDir: path.join(root, "generated"),
	};
	mkdirSync(dirs.casesDir, { recursive: true });
	mkdirSync(dirs.reportsDir, { recursive: true });
	mkdirSync(dirs.generatedDir, { recursive: true });
	return { root, dirs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("resolveRemoveTargets: standalone case", async () => {
	const { dirs, cleanup } = makeTmpDirs();
	try {
		writeFileSync(
			path.join(dirs.casesDir, "CD-010.jsonl"),
			JSON.stringify({ id: "CD-010", suite: "core", prompt: "test" }),
		);

		const targets = await resolveRemoveTargets("CD-010", dirs);

		assert.equal(targets.isBundle, false);
		assert.deepStrictEqual(targets.variantTags, []);
		assert.ok(targets.filesToDelete.some((f) => f.endsWith("CD-010.jsonl")));
		assert.deepStrictEqual(targets.dirsToDelete, []);
		assert.deepStrictEqual(targets.purgeArgs, [
			"--case", "CD-010",
			"--reports-dir", dirs.reportsDir,
		]);
	} finally {
		cleanup();
	}
});

test("resolveRemoveTargets: bundle case with variants", async () => {
	const { dirs, cleanup } = makeTmpDirs();
	try {
		writeFileSync(
			path.join(dirs.casesDir, "CD-015.jsonl"),
			JSON.stringify({
				id: "CD-015",
				suite: "core",
				prompt: "test",
				variants: [{ tag: "skill" }, { tag: "noskill" }],
			}),
		);

		// Create generated dir so it's detected
		const genDir = path.join(dirs.generatedDir, "core", "cd015");
		mkdirSync(genDir, { recursive: true });

		const targets = await resolveRemoveTargets("CD-015", dirs);

		assert.equal(targets.isBundle, true);
		assert.deepStrictEqual(targets.variantTags, ["skill", "noskill"]);
		assert.ok(targets.dirsToDelete.some((d) => d.includes("cd015")));
		assert.ok(targets.purgeArgs.includes("--variants"));
	} finally {
		cleanup();
	}
});

test("resolveRemoveTargets: includes routing trace files when trace dirs exist", async () => {
	const { dirs, cleanup } = makeTmpDirs();
	try {
		writeFileSync(
			path.join(dirs.casesDir, "CD-010.jsonl"),
			JSON.stringify({ id: "CD-010", suite: "core", prompt: "test" }),
		);

		// Create a model trace dir
		const modelDir = path.join(dirs.reportsDir, "routing-traces", "test-model");
		mkdirSync(modelDir, { recursive: true });

		const targets = await resolveRemoveTargets("CD-010", dirs);

		assert.ok(targets.filesToDelete.some((f) => f.includes("routing-traces") && f.endsWith(".json")));
	} finally {
		cleanup();
	}
});

test("executeRemove: deletes files and dirs within allowed roots", async () => {
	const { dirs, cleanup } = makeTmpDirs();
	try {
		const filePath = path.join(dirs.casesDir, "CD-010.jsonl");
		writeFileSync(filePath, "{}");

		const targets = {
			filesToDelete: [filePath],
			dirsToDelete: [],
			isBundle: false,
			variantTags: [],
			suite: "",
			purgeArgs: [],
		};

		const deleted = await executeRemove(targets, dirs);
		assert.ok(deleted.length > 0);
	} finally {
		cleanup();
	}
});

test("executeRemove: rejects files outside managed dirs", async () => {
	const { dirs, cleanup } = makeTmpDirs();
	try {
		const targets = {
			filesToDelete: ["/tmp/evil-file.json"],
			dirsToDelete: [],
			isBundle: false,
			variantTags: [],
			suite: "",
			purgeArgs: [],
		};

		await assert.rejects(
			() => executeRemove(targets, dirs),
			/outside managed dirs/,
		);
	} finally {
		cleanup();
	}
});
