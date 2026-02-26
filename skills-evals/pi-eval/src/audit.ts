import path from "node:path";
import { color, renderPanel, renderTable, symbols } from "./logger.js";
import { discoverSkills } from "./skills.js";
import { fileExists, normalizePath, resolvePath } from "./utils.js";
import type { EvalConfig, ModelSpec, SkillInfo } from "./types.js";

export type AuditResult = {
	model: ModelSpec;
	agentDir: string;
	skills: SkillInfo[];
	instructionChecks: Array<{ path: string; exists: boolean }>;
};

const getInstructionList = (config: EvalConfig, modelKey: string): string[] => {
	const modelConfig = config.models?.[modelKey] ?? config.models?.default;
	return modelConfig?.globalInstructions ?? ["AGENTS.md", "instructions/global.md"];
};

const instructionStatus = async (agentDir: string, paths: string[]) =>
	Promise.all(
		paths.map(async (item) => {
			const fullPath = resolvePath(item, agentDir);
			return { path: normalizePath(path.relative(agentDir, fullPath)), exists: await fileExists(fullPath) };
		}),
	);

export const runAudit = async (params: {
	config: EvalConfig;
	model: ModelSpec;
	agentDir: string;
	skillsPaths: string[];
}): Promise<AuditResult> => {
	const { config, model, agentDir, skillsPaths } = params;
	const skills = await discoverSkills(skillsPaths);
	const instructionList = getInstructionList(config, model.key);
	const instructionChecks = await instructionStatus(agentDir, instructionList);

	const header = renderPanel(
		"Pi Eval Audit",
		[
			`${color.accent("Model")}: ${model.label}`,
			`${color.accent("Agent Dir")}: ${agentDir}`,
			`${color.accent("Skills")}: ${skills.length}`,
			`${color.accent("Global Instructions")}: ${instructionChecks.length}`,
		].join("\n"),
	);

	console.log(header);
	console.log("");

	const instructionRows = instructionChecks.map((check) => [
		check.exists ? symbols.ok : symbols.fail,
		check.path,
		check.exists ? color.muted("found") : color.error("missing"),
	]);
	console.log(renderTable(["Status", "Instruction", "Notes"], instructionRows));
	console.log("");

	if (skills.length === 0) {
		console.log(`${symbols.warn} ${color.warning("No skills discovered")}`);
	} else {
		const skillRows = skills.map((skill) => [
			skill.name,
			skill.description ? color.muted(skill.description) : color.muted("(no description)"),
			normalizePath(path.relative(agentDir, skill.skillDir)),
		]);
		console.log(renderTable(["Skill", "Description", "Path"], skillRows, { split: [0.1, 0.6, 0.3] }));
	}

	console.log("");

	return { model, agentDir, skills, instructionChecks };
};
