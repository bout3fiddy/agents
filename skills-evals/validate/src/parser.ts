import { stat } from "node:fs/promises";
import path from "node:path";

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
