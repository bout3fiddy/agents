import { stat } from "node:fs/promises";
import path from "node:path";
import { findSkillMd } from "./parser.js";

const MAX_SKILL_NAME_LENGTH = 64;

const validateDirName = (dirName: string): string[] => {
	const errors: string[] = [];
	const normalized = dirName.trim().normalize("NFKC");

	if (normalized.length > MAX_SKILL_NAME_LENGTH) {
		errors.push(
			`Skill name '${normalized}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${normalized.length} chars)`,
		);
	}

	if (normalized !== normalized.toLowerCase()) {
		errors.push(`Skill name '${normalized}' must be lowercase`);
	}

	if (normalized.startsWith("-") || normalized.endsWith("-")) {
		errors.push("Skill name cannot start or end with a hyphen");
	}

	if (normalized.includes("--")) {
		errors.push("Skill name cannot contain consecutive hyphens");
	}

	if (!/^[\p{L}\p{N}-]+$/u.test(normalized)) {
		errors.push(
			`Skill name '${normalized}' contains invalid characters. Only letters, digits, and hyphens are allowed.`,
		);
	}

	return errors;
};

export const validate = async (skillDirPath: string): Promise<string[]> => {
	let skillDirStat;
	try {
		skillDirStat = await stat(skillDirPath);
	} catch {
		return [`Path does not exist: ${skillDirPath}`];
	}

	if (!skillDirStat.isDirectory()) {
		return [`Not a directory: ${skillDirPath}`];
	}

	const skillMd = await findSkillMd(skillDirPath);
	if (!skillMd) {
		return ["Missing required file: SKILL.md"];
	}

	return validateDirName(path.basename(skillDirPath));
};
