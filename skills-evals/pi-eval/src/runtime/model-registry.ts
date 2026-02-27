import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { EvalConfig, ModelSpec } from "../data/types.js";

export const modelSpecFromModel = (model: Model<any>): ModelSpec => ({
	provider: model.provider,
	id: model.id,
	key: `${model.provider}/${model.id}`,
	label: `${model.provider}/${model.id}`,
});

const modelSpecFromKey = (modelKey: string): ModelSpec | null => {
	const [provider, ...idParts] = modelKey.split("/");
	const id = idParts.join("/");
	if (!provider || !id) return null;
	return {
		provider,
		id,
		key: `${provider}/${id}`,
		label: `${provider}/${id}`,
	};
};

export const resolveModelSpec = async (
	modelArg: string | undefined,
	config: EvalConfig,
	ctx: ExtensionCommandContext,
): Promise<ModelSpec> => {
	let cached: Model<any>[] | null = null;
	const getAvailable = async (): Promise<Model<any>[]> => {
		if (cached) return cached;
		cached = await ctx.modelRegistry.getAvailable();
		return cached;
	};

	if (modelArg) {
		if (modelArg.includes("/")) {
			const parsed = modelSpecFromKey(modelArg);
			if (!parsed) throw new Error(`Invalid model format: ${modelArg}. Expected provider/model.`);
			return parsed;
		}
		const match = (await getAvailable()).find((item) => item.id === modelArg);
		if (!match) {
			throw new Error(
				`Model not found: ${modelArg}. Available: ${(await getAvailable())
					.map((item) => `${item.provider}/${item.id}`)
					.join(", ")}`,
			);
		}
		return modelSpecFromModel(match);
	}

	const configuredModel = config.requiredModels?.[0];
	if (typeof configuredModel === "string" && configuredModel.trim().length > 0) {
		if (configuredModel.includes("/")) {
			const parsed = modelSpecFromKey(configuredModel);
			if (parsed) return parsed;
		} else {
			const match = (await getAvailable()).find((item) => item.id === configuredModel);
			if (match) return modelSpecFromModel(match);
		}
	}

	if (ctx.model) return modelSpecFromModel(ctx.model);

	const available = await getAvailable();
	if (available.length === 0) {
		throw new Error("No models available. Configure a provider or login.");
	}
	return modelSpecFromModel(available[0]);
};

export const ensureModelAuth = async (
	model: ModelSpec,
	ctx: ExtensionCommandContext,
): Promise<void> => {
	const resolved = ctx.modelRegistry.find(model.provider, model.id);
	if (!resolved) {
		throw new Error(`Model not registered: ${model.provider}/${model.id}`);
	}
	const apiKey = await ctx.modelRegistry.getApiKey(resolved);
	if (!apiKey) {
		throw new Error(
			`Missing credentials for ${model.provider}/${model.id}. Authenticate before running evals.`,
		);
	}
};
