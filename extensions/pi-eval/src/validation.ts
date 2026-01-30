import { fileExists, resolvePath } from "./utils.js";

export const parseStringFlag = (
	name: string,
	value: string | boolean | undefined,
): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Flag ${name} expects a value.`);
	}
	return value;
};

export const parseLimitFlag = (value: string | boolean | undefined): number | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error("Flag --limit expects a positive integer value.");
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error("Flag --limit expects a positive integer value.");
	}
	return parsed;
};

export const resolveCasesPath = async (
	agentDir: string,
	value: string | boolean | undefined,
	defaultCasesPath: string,
): Promise<string> => {
	const rawValue = parseStringFlag("--cases", value) ?? defaultCasesPath;
	const resolved = resolvePath(rawValue, agentDir);
	if (!(await fileExists(resolved))) {
		throw new Error(`Cases file not found: ${resolved}`);
	}
	return resolved;
};
