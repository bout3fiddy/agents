import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./utils.js";
import type { EvalConfig } from "./types.js";

const extensionRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const getExtensionRoot = (): string => extensionRoot();

export const getConfigPath = (): string =>
	path.join(extensionRoot(), "config", "eval.config.json");

export const loadEvalConfig = async (): Promise<EvalConfig> => {
	const config = await readJson<EvalConfig>(getConfigPath());
	return config;
};
