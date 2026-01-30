import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SkillInfo } from "./types.js";
import { fileExists } from "./utils.js";

const parseFrontmatter = (content: string): Record<string, string> => {
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end === -1) return {};
	const raw = content.slice(3, end).trim();
	const meta: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIndex = trimmed.indexOf(":");
		if (colonIndex === -1) continue;
		const key = trimmed.slice(0, colonIndex).trim();
		const value = trimmed.slice(colonIndex + 1).trim();
		if (key) meta[key] = value.replace(/^"|"$/g, "");
	}
	return meta;
};

const walkForSkills = async (dir: string, items: SkillInfo[]): Promise<void> => {
	if (!(await fileExists(dir))) return;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkForSkills(fullPath, items);
			continue;
		}
		if (entry.isFile() && entry.name === "SKILL.md") {
			const skillDir = path.dirname(fullPath);
			const content = await readFile(fullPath, "utf-8");
			const meta = parseFrontmatter(content);
			const name = meta.name ?? path.basename(skillDir);
			const description = meta.description;
			items.push({ name, description, skillDir, skillFile: fullPath });
		}
	}
};

export const discoverSkills = async (skillPaths: string[]): Promise<SkillInfo[]> => {
	const items: SkillInfo[] = [];
	for (const skillPath of skillPaths) {
		await walkForSkills(skillPath, items);
	}
	return items;
};
