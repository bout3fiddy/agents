import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateRouterArtifact } from "./router_artifact_check.js";

const makeTempDir = async (): Promise<string> => {
	const dir = path.join(tmpdir(), `skills-router-artifact-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
};

test("router artifact validates when schema is correct", async () => {
	const sandboxDir = await makeTempDir();
	const artifactPath = path.join(sandboxDir, "skills.router.min.json");
	const artifact = {
		schema_version: "1",
		generated_at: "2026-02-27T00:00:00Z",
		skills: [
			{
				id: "coding",
				path: "skills/coding/SKILL.md",
				task_types: ["implementation"],
				priority: 1,
				activation_policy: "both",
				workflow_triggers: ["implementation_request_detected"],
				primary_refs: ["coding.ref.react.index"],
			},
		],
		by_task_type: { implementation: ["coding"] },
		by_workflow_trigger: { implementation_request_detected: ["coding"] },
	};

	await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
	const errors = await validateRouterArtifact(artifactPath);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("router artifact reports unknown skill ids in routing maps", async () => {
	const sandboxDir = await makeTempDir();
	const artifactPath = path.join(sandboxDir, "skills.router.min.json");
	const artifact = {
		schema_version: "1",
		generated_at: "2026-02-27T00:00:00Z",
		skills: [
			{
				id: "coding",
				path: "skills/coding/SKILL.md",
				task_types: ["implementation"],
				priority: 1,
				activation_policy: "both",
				workflow_triggers: ["implementation_request_detected"],
				primary_refs: ["coding.ref.react.index"],
			},
		],
		by_task_type: { implementation: ["coding"] },
		by_workflow_trigger: { implementation_request_detected: ["planning"] },
	};

	await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
	const errors = await validateRouterArtifact(artifactPath);
	assert.ok(
		errors.some((error) => error.includes("by_workflow_trigger.implementation_request_detected[0] references unknown skill ID 'planning'")),
	);
	await rm(sandboxDir, { recursive: true, force: true });
});
