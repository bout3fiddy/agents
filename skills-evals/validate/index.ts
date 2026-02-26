import { stat } from "node:fs/promises";
import path from "node:path";
import { validate } from "./src/validator.js";

const isSkillMdFile = async (candidatePath: string): Promise<boolean> => {
	try {
		const candidateStat = await stat(candidatePath);
		return candidateStat.isFile() && path.basename(candidatePath).toLowerCase() === "skill.md";
	} catch {
		return false;
	}
};

const showUsage = (): void => {
	process.stderr.write("Usage: bun run skills-evals/validate/index.ts validate SKILL_PATH\n");
};

const run = async (): Promise<void> => {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) {
		showUsage();
		process.exit(0);
	}
	if (argv.length !== 2 || argv[0] !== "validate") {
		showUsage();
		process.exit(1);
	}

	let skillPath = argv[1];
	if (await isSkillMdFile(skillPath)) {
		skillPath = path.dirname(skillPath);
	}

	const errors = await validate(skillPath);
	if (errors.length > 0) {
		process.stderr.write(`Validation failed for ${skillPath}:\n`);
		for (const error of errors) {
			process.stderr.write(`  - ${error}\n`);
		}
		process.exit(1);
	}

	process.stdout.write(`Valid skill: ${skillPath}\n`);
};

void run();
