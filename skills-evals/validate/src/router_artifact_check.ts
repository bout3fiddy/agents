import { readFile, stat } from "node:fs/promises";
import { activationPolicies, isRecord, schema } from "./schema.js";

const routerArtifact = schema.router_artifact as Record<string, unknown>;

const REQUIRED_TOP_LEVEL_KEYS = routerArtifact.required_top_level_keys as string[];
const REQUIRED_SKILL_KEYS = routerArtifact.required_skill_keys as string[];
const ALLOWED_ACTIVATION_POLICIES = activationPolicies;

const validateSkillNode = (skill: unknown, index: number): { errors: string[]; skillId?: string } => {
	const errors: string[] = [];
	if (!isRecord(skill)) {
		return { errors: [`skills[${index}] must be an object`] };
	}

	for (const key of REQUIRED_SKILL_KEYS) {
		if (!Object.hasOwn(skill, key)) {
			errors.push(`skills[${index}] missing required key: ${key}`);
		}
	}

	let skillId: string | undefined;
	if (Object.hasOwn(skill, "id")) {
		if (typeof skill.id !== "string" || skill.id.length === 0) {
			errors.push(`skills[${index}].id must be a non-empty string`);
		} else {
			skillId = skill.id;
		}
	}

	if (Object.hasOwn(skill, "path")) {
		if (typeof skill.path !== "string") {
			errors.push(`skills[${index}].path must be a string`);
		} else if (skill.path.trim().length === 0) {
			errors.push(`skills[${index}].path must be a non-empty string`);
		}
	}

	if (Object.hasOwn(skill, "task_types") && !Array.isArray(skill.task_types)) {
		errors.push(`skills[${index}].task_types must be an array`);
	}
	if (Array.isArray(skill.task_types)) {
		if (skill.task_types.length === 0) {
			errors.push(`skills[${index}].task_types must contain at least one task type`);
		}
		for (const [taskIndex, taskType] of skill.task_types.entries()) {
			if (typeof taskType !== "string" || taskType.length === 0) {
				errors.push(
					`skills[${index}].task_types[${taskIndex}] must be a non-empty string`,
				);
			}
		}
	}

	if (Object.hasOwn(skill, "priority") && typeof skill.priority !== "number") {
		errors.push(`skills[${index}].priority must be a number`);
	}

	if (
		Object.hasOwn(skill, "activation_policy") &&
		typeof skill.activation_policy !== "string"
	) {
		errors.push(`skills[${index}].activation_policy must be a string`);
	}
	if (
		typeof skill.activation_policy === "string" &&
		!ALLOWED_ACTIVATION_POLICIES.has(skill.activation_policy)
	) {
		errors.push(
			`skills[${index}].activation_policy must be one of: ${Array.from(ALLOWED_ACTIVATION_POLICIES).join(", ")}`,
		);
	}

	if (
		Object.hasOwn(skill, "workflow_triggers") &&
		!Array.isArray(skill.workflow_triggers)
	) {
		errors.push(`skills[${index}].workflow_triggers must be an array`);
	}
	if (Array.isArray(skill.workflow_triggers)) {
		for (const [triggerIndex, trigger] of skill.workflow_triggers.entries()) {
			if (typeof trigger !== "string" || trigger.length === 0) {
				errors.push(
					`skills[${index}].workflow_triggers[${triggerIndex}] must be a non-empty string`,
				);
			}
		}
	}

	if (Object.hasOwn(skill, "primary_refs") && !Array.isArray(skill.primary_refs)) {
		errors.push(`skills[${index}].primary_refs must be an array`);
	}
	if (Array.isArray(skill.primary_refs)) {
		for (const [refIndex, refId] of skill.primary_refs.entries()) {
			if (typeof refId !== "string" || refId.length === 0) {
				errors.push(
					`skills[${index}].primary_refs[${refIndex}] must be a non-empty string`,
				);
			}
		}
	}

	return { errors, skillId };
};

const validateRoutingMap = (
	mapName: string,
	mapValue: unknown,
	knownSkillIds: Set<string>,
): string[] => {
	const errors: string[] = [];
	if (!isRecord(mapValue)) {
		errors.push(`${mapName} must be an object mapping keys to skill ID arrays`);
		return errors;
	}

	for (const key of Object.keys(mapValue).sort((a, b) => a.localeCompare(b))) {
		const ids = mapValue[key];
		if (!Array.isArray(ids)) {
			errors.push(`${mapName}.${key} must be an array of skill IDs`);
			continue;
		}

		for (const [index, skillId] of ids.entries()) {
			if (typeof skillId !== "string" || skillId.length === 0) {
				errors.push(`${mapName}.${key}[${index}] must be a non-empty string skill ID`);
				continue;
			}
			if (!knownSkillIds.has(skillId)) {
				errors.push(`${mapName}.${key}[${index}] references unknown skill ID '${skillId}'`);
			}
		}
	}

	return errors;
};

const collectMappedSkillIds = (mapValue: unknown): Set<string> => {
	const mappedSkillIds = new Set<string>();
	if (!isRecord(mapValue)) {
		return mappedSkillIds;
	}

	for (const value of Object.values(mapValue)) {
		if (!Array.isArray(value)) {
			continue;
		}
		for (const item of value) {
			if (typeof item === "string" && item.length > 0) {
				mappedSkillIds.add(item);
			}
		}
	}

	return mappedSkillIds;
};

export const validateRouterArtifact = async (artifactPath: string): Promise<string[]> => {
	try {
		const artifactStat = await stat(artifactPath);
		if (!artifactStat.isFile()) {
			return [`Expected a file at path: ${artifactPath}`];
		}
	} catch {
		return [`Missing required file: ${artifactPath}`];
	}

	let parsed: unknown;
	try {
		const content = await readFile(artifactPath, "utf8");
		parsed = JSON.parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Failed to parse JSON at ${artifactPath}: ${message}`];
	}

	if (!isRecord(parsed)) {
		return ["Router artifact root must be a JSON object"];
	}

	const errors: string[] = [];
	for (const key of REQUIRED_TOP_LEVEL_KEYS) {
		if (!Object.hasOwn(parsed, key)) {
			errors.push(`Missing required top-level key: ${key}`);
		}
	}

	if (Object.hasOwn(parsed, "schema_version") && typeof parsed.schema_version !== "string") {
		errors.push("Top-level key 'schema_version' must be a string");
	}
	if (Object.hasOwn(parsed, "generated_at") && typeof parsed.generated_at !== "string") {
		errors.push("Top-level key 'generated_at' must be a string");
	}

	const knownSkillIds = new Set<string>();
	if (!Array.isArray(parsed.skills)) {
		errors.push("Top-level key 'skills' must be an array");
	} else {
		if (parsed.skills.length === 0) {
			errors.push("Top-level key 'skills' must not be empty");
		}
		for (const [index, skill] of parsed.skills.entries()) {
			const result = validateSkillNode(skill, index);
			errors.push(...result.errors);
			if (result.skillId) {
				if (knownSkillIds.has(result.skillId)) {
					errors.push(`Duplicate skill ID in skills array: '${result.skillId}'`);
				}
				knownSkillIds.add(result.skillId);
			}
		}
	}

	errors.push(...validateRoutingMap("by_task_type", parsed.by_task_type, knownSkillIds));
	errors.push(
		...validateRoutingMap("by_workflow_trigger", parsed.by_workflow_trigger, knownSkillIds),
	);

	const byTaskTypeSkillIds = collectMappedSkillIds(parsed.by_task_type);
	for (const skillId of Array.from(knownSkillIds).sort((a, b) => a.localeCompare(b))) {
		if (!byTaskTypeSkillIds.has(skillId)) {
			errors.push(
				`by_task_type does not cover included skill ID '${skillId}' (every included skill must appear in at least one task-type bucket)`,
			);
		}
	}

	return errors;
};
