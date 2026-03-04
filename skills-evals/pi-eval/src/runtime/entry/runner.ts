import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizeArgs, parseFlags } from "../../cli/args.js";
import { evaluateSelectedCases } from "../case/case-execution.js";
import { loadCases, filterCases } from "../../data/cases.js";
import { loadEvalConfig } from "../../data/config.js";
import { persistRunReport } from "../../reporting/report-persistence.js";
import { formatDuration } from "../../data/utils.js";
import {
	isSameResolvedPath,
	resolveRunOptions,
	validateRunMode,
} from "../../cli/run-options.js";
import { runJudge } from "../../judging/judge.js";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerExtensionEntry = path.join(extensionRoot, "worker.ts");

export const registerEvalCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("eval", {
		description: "Run eval cases and write reports",
		handler: async (args, ctx) => {
			const { flags, positionals } = parseFlags(tokenizeArgs(args ?? ""));
			validateRunMode(positionals);

			const config = await loadEvalConfig();
			const options = await resolveRunOptions(flags, ctx, config);
			const defaultLoaded = await loadCases(options.defaultCasesPath);
			const selectedLoaded = isSameResolvedPath(options.casesPath, options.defaultCasesPath)
				? defaultLoaded
				: await loadCases(options.casesPath);
			const filtered = filterCases(selectedLoaded, options.filter, options.limitOverride);
			const { cases, bundles } = filtered;
				if (cases.length === 0) return;

				const runStart = Date.now();
				const evaluations = await evaluateSelectedCases({
					cases,
					options,
					config,
					extensionEntry: workerExtensionEntry,
				});
			const verdicts = await runJudge({
				evaluations,
				cases,
				bundles,
				options,
				agentDir: options.agentDir,
			});
			const caseById = new Map(cases.map((c) => [c.id, c]));
			for (const evaluation of evaluations) {
				const evalCase = caseById.get(evaluation.caseId);
				if (evalCase?.bundleId && verdicts.has(evalCase.bundleId)) {
					evaluation.judgeVerdict = verdicts.get(evalCase.bundleId)!;
				}
			}

			const durationMs = Date.now() - runStart;
			const passed = evaluations.filter((item) => item.status === "pass").length;
			const failed = evaluations.length - passed;

			const paths = await persistRunReport({
				options,
				defaultCases: defaultLoaded.cases,
				evaluations,
				bundles,
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
