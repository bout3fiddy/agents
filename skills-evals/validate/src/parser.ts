import { stat } from "node:fs/promises";
import path from "node:path";
import { ParseError } from "./errors.js";

type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | Record<string, FrontmatterValue>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeMetadataValue = (value: unknown): FrontmatterValue => {
	if (value === null) {
		return null;
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeMetadataValue(item));
	}

	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [String(key), normalizeMetadataValue(nested)]),
		);
	}

	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? value
		: String(value);
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

const findClosingFrontmatterIndex = (content: string): number => {
	const DELIMITER_LINE = /^\s*---\s*$/m;
	const searchFrom = content.indexOf("\n");
	if (searchFrom === -1) return -1;
	const match = DELIMITER_LINE.exec(content.slice(searchFrom + 1));
	if (!match) return -1;
	return searchFrom + 1 + match.index;
};

export const parseFrontmatter = (content: string): Record<string, unknown> => {
	if (!content.startsWith("---")) {
		throw new ParseError("SKILL.md must start with YAML frontmatter (---)");
	}

	const closingMarkerIndex = findClosingFrontmatterIndex(content);
	if (closingMarkerIndex === -1) {
		throw new ParseError("SKILL.md frontmatter not properly closed with ---");
	}

	const firstNewline = content.indexOf("\n");
	const frontmatterText = content.slice(firstNewline + 1, closingMarkerIndex);

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

	if (Object.hasOwn(parsed, "metadata")) {
		if (!isRecord(parsed.metadata)) {
			throw new ParseError("Invalid YAML in frontmatter: field 'metadata' must be a mapping");
		}

		parsed.metadata = Object.fromEntries(
			Object.entries(parsed.metadata).map(([key, value]) => [String(key), normalizeMetadataValue(value)]),
		);
	}

	return parsed;
};
