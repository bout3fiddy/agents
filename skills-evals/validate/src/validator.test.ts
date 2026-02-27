import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validate } from "./validator.js";

const makeSandboxDir = async (): Promise<string> => {
	const sandboxDir = path.join(tmpdir(), `skills-validate-${randomUUID()}`);
	await mkdir(sandboxDir, { recursive: true });
	return sandboxDir;
};

const makeSkillDir = async (skillName: string): Promise<{ sandboxDir: string; skillDir: string }> => {
	const sandboxDir = await makeSandboxDir();
	const skillDir = path.join(sandboxDir, skillName);
	await mkdir(skillDir, { recursive: true });
	return { sandboxDir, skillDir };
};

test("valid skill", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: my-skill\ndescription: A test skill\n---\n# My Skill\n",
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("nonexistent path", async () => {
	const sandboxDir = await makeSandboxDir();
	const missingPath = path.join(sandboxDir, "nonexistent");
	const errors = await validate(missingPath);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /does not exist/);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("not a directory", async () => {
	const sandboxDir = await makeSandboxDir();
	const filePath = path.join(sandboxDir, "file.txt");
	await writeFile(filePath, "test");
	const errors = await validate(filePath);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /Not a directory/);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("missing SKILL.md", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	const errors = await validate(skillDir);
	assert.equal(errors.length, 1);
	assert.equal(errors[0], "Missing required file: SKILL.md");
	await rm(sandboxDir, { recursive: true, force: true });
});

test("frontmatter must exist", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(path.join(skillDir, "SKILL.md"), "# No frontmatter\n");
	const errors = await validate(skillDir);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /must start with YAML frontmatter/);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("frontmatter must be closed", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: A test\n");
	const errors = await validate(skillDir);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /not properly closed/);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("invalid name uppercase", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("MySkill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: MySkill\ndescription: A test skill\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("lowercase")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("name too long", async () => {
	const longName = "a".repeat(70);
	const { sandboxDir, skillDir } = await makeSkillDir(longName);
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${longName}\ndescription: A test skill\n---\nBody\n`,
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("character limit")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("leading hyphen in name", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("-my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: -my-skill\ndescription: A test skill\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("cannot start or end with a hyphen")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("consecutive hyphens in name", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my--skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: my--skill\ndescription: A test skill\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("consecutive hyphens")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("invalid characters in name", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my_skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: my_skill\ndescription: A test skill\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("invalid characters")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("directory name mismatch", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("wrong-name");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: correct-name\ndescription: A test skill\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("must match skill name")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("unexpected fields", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: my-skill\ndescription: A test skill\nunknown_field: no\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("Unexpected fields")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("valid with all fields", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			"license: MIT",
			"metadata:",
			"  author: Test",
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("metadata contract values are supported", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			"metadata:",
			"  id: my-skill",
			"  task_types:",
			"    - implementation",
			"    - refactor",
			"  workflow_triggers:",
			"    - implementation_request_detected",
			"  route_exclude: false",
			"  priority: 90",
			"  activation_policy: both",
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("invalid metadata contract values are rejected", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			"metadata:",
			"  task_types: not-an-array",
			"  priority: high",
			"  route_exclude: maybe",
			"  activation_policy: definitely-not-a-policy",
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.equal(errors.length >= 4, true);
	assert.ok(errors.some((error) => error === "Field 'metadata.task_types' must be an array"));
	assert.ok(errors.some((error) => error === "Field 'metadata.priority' must be a number"));
	assert.ok(errors.some((error) => error === "Field 'metadata.route_exclude' must be a boolean"));
	assert.ok(errors.some((error) => error.startsWith("Field 'metadata.activation_policy' must be one of: ")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("allowed-tools accepted", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			"allowed-tools: Bash(jq:*) Bash(git:*)",
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("i18n chinese name", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("技能");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: 技能\ndescription: A skill with Chinese name\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("i18n russian lowercase valid", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("навык");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: навык\ndescription: A skill with Russian lowercase name\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("i18n russian uppercase rejected", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("НАВЫК");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: НАВЫК\ndescription: A skill with Russian uppercase name\n---\nBody\n",
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("lowercase")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("description too long", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	const longDescription = "x".repeat(1100);
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		`---\nname: my-skill\ndescription: ${longDescription}\n---\nBody\n`,
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("1024")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("valid compatibility", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			"compatibility: Requires Python 3.11+",
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});

test("compatibility too long", async () => {
	const { sandboxDir, skillDir } = await makeSkillDir("my-skill");
	const longCompatibility = "x".repeat(550);
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			"name: my-skill",
			"description: A test skill",
			`compatibility: ${longCompatibility}`,
			"---",
			"Body",
			"",
		].join("\n"),
	);
	const errors = await validate(skillDir);
	assert.ok(errors.some((error) => error.includes("500")));
	await rm(sandboxDir, { recursive: true, force: true });
});

test("nfkc normalization for composed and decomposed names", async () => {
	const decomposedName = "cafe\u0301";
	const composedName = "café";
	const { sandboxDir, skillDir } = await makeSkillDir(composedName);
	await writeFile(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${decomposedName}\ndescription: A test skill\n---\nBody\n`,
	);
	const errors = await validate(skillDir);
	assert.deepEqual(errors, []);
	await rm(sandboxDir, { recursive: true, force: true });
});
