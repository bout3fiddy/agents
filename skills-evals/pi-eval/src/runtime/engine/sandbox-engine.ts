import type { ModelSpec } from "../../data/types.js";
import { createGondolinSandboxEngine } from "./gondolin-engine.js";

export type SandboxLaunchPolicyInput = {
	model: ModelSpec;
	sandboxWorkspaceDir: string;
	workerOutputPath: string;
	sandboxHomeDir?: string | null;
};

export type SandboxLaunchRequest = {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	policy: SandboxLaunchPolicyInput;
};

export type SandboxedProcessHandle = {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	waitForExit: () => Promise<number>;
	kill: () => void;
	cleanup: () => Promise<void>;
};

export type SandboxEngine = {
	launchWorker: (request: SandboxLaunchRequest) => Promise<SandboxedProcessHandle>;
};

const PROVIDER_ALLOWED_HOSTS: Record<string, string[]> = {
	anthropic: ["api.anthropic.com", "anthropic.com", "*.anthropic.com"],
	deepseek: ["api.deepseek.com", "deepseek.com", "*.deepseek.com"],
	gemini: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "*.googleapis.com"],
	google: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "*.googleapis.com"],
	groq: ["api.groq.com", "groq.com", "*.groq.com"],
	mistral: ["api.mistral.ai", "mistral.ai", "*.mistral.ai"],
	openai: ["api.openai.com", "openai.com", "*.openai.com"],
	"openai-codex": [
		"api.openai.com",
		"openai.com",
		"*.openai.com",
		"chatgpt.com",
		"*.chatgpt.com",
	],
	openrouter: ["api.openrouter.ai", "openrouter.ai", "*.openrouter.ai"],
	ollama: ["localhost", "127.0.0.1", "::1"],
	vertex: ["aiplatform.googleapis.com", "*.googleapis.com"],
	xai: ["api.x.ai", "x.ai", "*.x.ai"],
};

import { uniqueSorted } from "../../data/utils.js";

export const resolveProviderAllowedHosts = (model: ModelSpec): string[] => {
	const providerKey = model.provider.trim().toLowerCase();
	if (providerKey.length === 0) {
		throw new Error("Missing model provider for sandbox network policy.");
	}
	const hosts = PROVIDER_ALLOWED_HOSTS[providerKey];
	if (hosts && hosts.length > 0) return uniqueSorted(hosts);
	if (providerKey === "local") return [...PROVIDER_ALLOWED_HOSTS.ollama];
	throw new Error(
		`No sandbox network allowlist for model provider '${model.provider}' (${model.provider}/${model.id}).`,
	);
};

export const createMandatorySandboxEngine = (): SandboxEngine =>
	createGondolinSandboxEngine();
