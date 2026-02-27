import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findSkillMd, parseFrontmatter } from "./parser.js";

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;
const ALLOWED_ACTIVATION_POLICIES = new Set(["user_intent", "workflow_state", "both"]);
const ALLOWED_METADATA_KEYS = new Set([
	"id",
	"version",
	"task_types",
	"trigger_phrases",
	"priority",
	"load_strategy",
	"activation_policy",
	"workflow_triggers",
	"route_exclude",
]);

const ALLOWED_FIELDS = [
	"name",
	"description",
	"license",
	"allowed-tools",
	"metadata",
	"compatibility",
] as const;
const ALLOWED_FIELD_SET = new Set<string>(ALLOWED_FIELDS);
const ALLOWED_FIELDS_LABEL = `[${[...ALLOWED_FIELDS].sort().map((field) => `'${field}'`).join(", ")}]`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const validateMetadataContract = (metadata: unknown): string[] => {
	const errors: string[] = [];

	if (!isRecord(metadata)) {
		errors.push("Field 'metadata' must be a mapping");
		return errors;
	}

	for (const field of Object.keys(metadata)) {
		if (!ALLOWED_METADATA_KEYS.has(field)) {
			continue;
		}

		const value = metadata[field];
		switch (field) {
			case "id":
			case "version":
			case "load_strategy": {
				if (typeof value !== "string") {
					errors.push(`Field 'metadata.${field}' must be a string`);
				}
				break;
			}
			case "task_types":
			case "trigger_phrases":
			case "workflow_triggers": {
				if (!Array.isArray(value)) {
					errors.push(`Field 'metadata.${field}' must be an array`);
					break;
				}
				for (const [index, item] of value.entries()) {
					if (typeof item !== "string" || item.length === 0) {
						errors.push(
							`Field 'metadata.${field}[${index}]' must be a non-empty string`,
						);
					}
				}
				break;
			}
			case "priority": {
				if (typeof value !== "number") {
					errors.push("Field 'metadata.priority' must be a number");
				}
				break;
			}
			case "activation_policy": {
				if (typeof value !== "string") {
					errors.push("Field 'metadata.activation_policy' must be a string");
					break;
				}
				if (!ALLOWED_ACTIVATION_POLICIES.has(value)) {
					errors.push(
						`Field 'metadata.activation_policy' must be one of: ${Array.from(ALLOWED_ACTIVATION_POLICIES).join(", ")}`,
					);
				}
				break;
			}
			case "route_exclude": {
				if (typeof value !== "boolean") {
					errors.push("Field 'metadata.route_exclude' must be a boolean");
				}
				break;
			}
		}
	}

	return errors;
};

const validateName = (name: unknown, skillDirName?: string): string[] => {
	const errors: string[] = [];

	if (typeof name !== "string" || name.trim().length === 0) {
		errors.push("Field 'name' must be a non-empty string");
		return errors;
	}

	const normalizedName = name.trim().normalize("NFKC");

	if (normalizedName.length > MAX_SKILL_NAME_LENGTH) {
		errors.push(
			`Skill name '${normalizedName}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${normalizedName.length} chars)`,
		);
	}

	if (normalizedName !== normalizedName.toLowerCase()) {
		errors.push(`Skill name '${normalizedName}' must be lowercase`);
	}

	if (normalizedName.startsWith("-") || normalizedName.endsWith("-")) {
		errors.push("Skill name cannot start or end with a hyphen");
	}

	if (normalizedName.includes("--")) {
		errors.push("Skill name cannot contain consecutive hyphens");
	}

	if (!/^[\p{L}\p{N}-]+$/u.test(normalizedName)) {
		errors.push(
			`Skill name '${normalizedName}' contains invalid characters. Only letters, digits, and hyphens are allowed.`,
		);
	}

	if (skillDirName && skillDirName.normalize("NFKC") !== normalizedName) {
		errors.push(`Directory name '${skillDirName}' must match skill name '${normalizedName}'`);
	}

	return errors;
};

const validateDescription = (description: unknown): string[] => {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim().length === 0) {
		errors.push("Field 'description' must be a non-empty string");
		return errors;
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(
			`Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${description.length} chars)`,
		);
	}

	return errors;
};

const validateCompatibility = (compatibility: unknown): string[] => {
	const errors: string[] = [];

	if (typeof compatibility !== "string") {
		errors.push("Field 'compatibility' must be a string");
		return errors;
	}

	if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
		errors.push(
			`Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} character limit (${compatibility.length} chars)`,
		);
	}

	return errors;
};

const validateMetadataFields = (metadata: Record<string, unknown>): string[] => {
	const extras = Object.keys(metadata).filter((field) => !ALLOWED_FIELD_SET.has(field));
	if (extras.length === 0) {
		return [];
	}

	return [
		`Unexpected fields in frontmatter: ${extras.sort().join(", ")}. Only ${ALLOWED_FIELDS_LABEL} are allowed.`,
	];
};

export const validateMetadata = (
	metadata: Record<string, unknown>,
	skillDirName?: string,
): string[] => {
	const errors: string[] = [];

	errors.push(...validateMetadataFields(metadata));

	if (!Object.hasOwn(metadata, "name")) {
		errors.push("Missing required field in frontmatter: name");
	} else {
		errors.push(...validateName(metadata.name, skillDirName));
	}

	if (!Object.hasOwn(metadata, "description")) {
		errors.push("Missing required field in frontmatter: description");
	} else {
		errors.push(...validateDescription(metadata.description));
	}

	if (Object.hasOwn(metadata, "compatibility")) {
		errors.push(...validateCompatibility(metadata.compatibility));
	}

	if (Object.hasOwn(metadata, "metadata")) {
		errors.push(...validateMetadataContract(metadata.metadata));
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

	try {
		const content = await readFile(skillMd, "utf8");
		const metadata = parseFrontmatter(content);
		return validateMetadata(metadata, path.basename(skillDirPath));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [message];
	}
};
