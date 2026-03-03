import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderAllowedHosts } from "../../src/runtime/sandbox-engine.js";

test("resolveProviderAllowedHosts includes openai-codex alias", () => {
	const hosts = resolveProviderAllowedHosts({
		provider: "openai-codex",
		id: "gpt-5.3-codex",
		key: "openai-codex/gpt-5.3-codex",
		label: "openai-codex/gpt-5.3-codex",
	});
	assert.equal(hosts.includes("api.openai.com"), true);
});

test("resolveProviderAllowedHosts falls back for local provider", () => {
	const hosts = resolveProviderAllowedHosts({
		provider: "local",
		id: "llama3",
		key: "local/llama3",
		label: "local/llama3",
	});
	assert.deepEqual(hosts.includes("localhost"), true);
});

test("resolveProviderAllowedHosts fails closed for unknown providers", () => {
	assert.throws(
		() =>
			resolveProviderAllowedHosts({
				provider: "unknown-provider",
				id: "model-x",
				key: "unknown-provider/model-x",
				label: "unknown-provider/model-x",
			}),
		/network allowlist/,
	);
});
