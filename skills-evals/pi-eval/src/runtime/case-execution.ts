import { runCase, buildErrorEvaluation } from "./case-lifecycle.js";
import { runItemsInParallel } from "./parallel.js";
import type { CaseEvaluation, EvalCase, EvalConfig, EvalRunOptions, SkillInfo } from "../data/types.js";

export const resolveSkillMap = (skills: SkillInfo[]): Map<string, SkillInfo> => {
	const map = new Map<string, SkillInfo>();
	for (const skill of skills) {
		if (!map.has(skill.name)) map.set(skill.name, skill);
	}
	return map;
};

export const evaluateSelectedCases = async (params: {
	cases: EvalCase[];
	options: EvalRunOptions;
	config: EvalConfig;
	skillMap: Map<string, SkillInfo>;
	extensionEntry: string;
}): Promise<CaseEvaluation[]> => {
	const { cases, options, config, skillMap, extensionEntry } = params;
	return runItemsInParallel(cases, options.caseParallelism, async (evalCase) => {
		const dryRun = options.dryRunOverride ? true : evalCase.dryRun ?? config.defaults?.dryRun ?? false;
		try {
			return await runCase({
				evalCase,
				skillMap,
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
