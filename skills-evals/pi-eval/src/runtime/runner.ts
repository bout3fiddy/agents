import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizeArgs, parseFlags } from "../cli/args.js";
import { evaluateSelectedCases, resolveSkillMap } from "./case-execution.js";
import { loadCases, filterCases } from "../data/cases.js";
import { loadEvalConfig } from "../data/config.js";
import { persistRunReport } from "../reporting/report-persistence.js";
import { discoverSkills } from "../data/skills.js";
import { formatDuration } from "../data/utils.js";
import {
	isSameResolvedPath,
	resolveRunOptions,
	resolveSkillsPaths,
	validateRunMode,
} from "../cli/run-options.js";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionEntry = path.join(extensionRoot, "index.ts");

export const registerEvalCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("eval", {
		description: "Run eval cases and write reports",
		handler: async (args, ctx) => {
			const { flags, positionals } = parseFlags(tokenizeArgs(args ?? ""));
			validateRunMode(positionals);

			const config = await loadEvalConfig();
			const options = await resolveRunOptions(flags, ctx, config);
			const defaultCases = await loadCases(options.defaultCasesPath);
			const selectedCases = isSameResolvedPath(options.casesPath, options.defaultCasesPath)
				? defaultCases
				: await loadCases(options.casesPath);
			const cases = filterCases(selectedCases, options.filter, options.limitOverride);
			if (cases.length === 0) return;

			const skills = await discoverSkills(resolveSkillsPaths(config, options.agentDir));
			const skillMap = resolveSkillMap(skills);
			const runStart = Date.now();
			const evaluations = await evaluateSelectedCases({
				cases,
				options,
				config,
				skillMap,
				extensionEntry,
			});
			const durationMs = Date.now() - runStart;
			const passed = evaluations.filter((item) => item.status === "pass").length;
			const failed = evaluations.length - passed;

			const paths = await persistRunReport({
				options,
				defaultCases,
				evaluations,
				durationMs,
			});

			console.log(
				JSON.stringify({
					cases: evaluations.length,
					pass: passed,
					fail: failed,
					duration: formatDuration(durationMs),
					report: paths.reportPath,
					indexUpdated: options.isFullRun ? paths.indexPath : null,
				}),
			);
		},
	});
};
