import { stat } from "node:fs/promises";
import path from "node:path";
import { ParseError } from "./errors.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const findSkillMd = async (skillDir: string): Promise<string | null> => {
	for (const name of ["SKILL.md", "skill.md"]) {
		const candidate = path.join(skillDir, name);
		try {
			if ((await stat(candidate)).isFile()) {
				return candidate;
			}
		} catch {
			// Try the next candidate.
		}
	}
	return null;
};

export const parseFrontmatter = (content: string): Record<string, unknown> => {
	if (!content.startsWith("---")) {
		throw new ParseError("SKILL.md must start with YAML frontmatter (---)");
	}

	const closingMarkerIndex = content.indexOf("---", 3);
	if (closingMarkerIndex === -1) {
		throw new ParseError("SKILL.md frontmatter not properly closed with ---");
	}

	const frontmatterText = content.slice(3, closingMarkerIndex);

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(frontmatterText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ParseError(`Invalid YAML in frontmatter: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new ParseError("SKILL.md frontmatter must be a YAML mapping");
	}

	for (const [key, value] of Object.entries(parsed)) {
		if (key === "metadata") {
			continue;
		}
		if (Array.isArray(value) || isRecord(value)) {
			throw new ParseError(`Invalid YAML in frontmatter: field '${key}' must be a scalar value`);
		}
		if (value !== null && value !== undefined && typeof value !== "string") {
			parsed[key] = String(value);
		}
	}

	if (isRecord(parsed.metadata)) {
		parsed.metadata = Object.fromEntries(
			Object.entries(parsed.metadata).map(([key, value]) => [String(key), String(value)]),
		);
	}

	return parsed;
};
