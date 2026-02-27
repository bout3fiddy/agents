import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRouterArtifact } from "./src/router_artifact_check.js";
import { validate } from "./src/validator.js";

const isSkillMdFile = async (candidatePath: string): Promise<boolean> => {
	try {
		const candidateStat = await stat(candidatePath);
		return candidateStat.isFile() && path.basename(candidatePath).toLowerCase() === "skill.md";
	} catch {
		return false;
	}
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROUTER_ARTIFACT_PATH = path.join(REPO_ROOT, "instructions", "skills.router.min.json");

const showUsage = (): void => {
	process.stderr.write("Usage:\n");
	process.stderr.write("  bun run skills-evals/validate/index.ts validate SKILL_PATH\n");
	process.stderr.write(
		"  bun run skills-evals/validate/index.ts check-router-artifact [ARTIFACT_PATH]\n",
	);
};

const run = async (): Promise<void> => {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) {
		showUsage();
		process.exit(0);
	}

	if (argv.length === 0) {
		showUsage();
		process.exit(1);
	}

	if (argv[0] === "validate") {
		if (argv.length !== 2) {
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
		return;
	}

	if (argv[0] === "check-router-artifact") {
		if (argv.length > 2) {
			showUsage();
			process.exit(1);
		}

		const artifactPath = argv[1] ?? DEFAULT_ROUTER_ARTIFACT_PATH;
		const errors = await validateRouterArtifact(artifactPath);
		if (errors.length > 0) {
			process.stderr.write(`Router artifact validation failed for ${artifactPath}:\n`);
			for (const error of errors) {
				process.stderr.write(`  - ${error}\n`);
			}
			process.exit(1);
		}

		process.stdout.write(`Router artifact is valid: ${artifactPath}\n`);
		return;
	}

	showUsage();
	process.exit(1);
};

void run();
