import { runCase, buildErrorEvaluation } from "./case-lifecycle.js";
import { runItemsInParallel } from "../util/parallel.js";
import type { CaseEvaluation, EvalConfig, EvalRunOptions, ResolvedEvalCase } from "../../data/types.js";

export const evaluateSelectedCases = async (params: {
	cases: ResolvedEvalCase[];
	options: EvalRunOptions;
	config: EvalConfig;
	extensionEntry: string;
}): Promise<CaseEvaluation[]> => {
	const { cases, options, config, extensionEntry } = params;
	return runItemsInParallel(cases, options.caseParallelism, async (evalCase) => {
		const dryRun = options.dryRunOverride ? true : evalCase.dryRun ?? config.defaults?.dryRun ?? false;
		try {
			return await runCase({
				evalCase,
				model: options.model,
				agentDir: options.agentDir,
				dryRun,
				thinkingLevel: options.thinkingLevel,
				authSourcePath: options.evalAuthSource,
				extensionEntry,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return buildErrorEvaluation(evalCase, dryRun, `run error: ${message}`);
		}
	});
};
