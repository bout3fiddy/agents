/**
 * Shared schema loader for the skill metadata constants.
 *
 * Both validator.ts and router_artifact_check.ts need the same schema.
 * This module loads and parses it once at module level.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../schemas/skill-metadata.schema.json");
const raw = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

export const schema = raw;
export const activationPolicies = new Set(raw.activation_policies as string[]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
