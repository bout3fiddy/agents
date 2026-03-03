import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EvalBundle, EvalCase, EvalCaseVariant, LoadedCases, ResolvedEvalCase } from "./types.js";

const ARTIFACT_PATH_PLACEHOLDER = "{{artifactPath}}";

const slugFromId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "");

const resolveArtifactPath = (suite: string, caseSlug: string, tag: string): string =>
	`skills-evals/generated/${suite}/${caseSlug}/${tag}/solution.py`;

const interpolateArtifactPath = (value: string, artifactPath: string): string =>
	value.split(ARTIFACT_PATH_PLACEHOLDER).join(artifactPath);

const interpolateFileAssertions = (
	assertions: NonNullable<EvalCase["fileAssertions"]>,
	artifactPath: string,
): NonNullable<EvalCase["fileAssertions"]> =>
	assertions.map((a) => ({ ...a, path: interpolateArtifactPath(a.path, artifactPath) }));

const interpolateDenyPaths = (paths: string[], artifactPath: string): string[] =>
	paths.map((p) => interpolateArtifactPath(p, artifactPath));

const flattenBundle = (
	raw: EvalCase & { variants: EvalCaseVariant[] },
): { cases: ResolvedEvalCase[]; bundle: EvalBundle } => {
	const bundleId = raw.id;
	const suite = raw.suite;
	const slug = slugFromId(bundleId);
	const variantTags = raw.variants.map((v) => v.tag);

	const variantArtifactPaths = new Map<string, string>();
	for (const variant of raw.variants) {
		variantArtifactPaths.set(variant.tag, resolveArtifactPath(suite, slug, variant.tag));
	}

	const cases: ResolvedEvalCase[] = raw.variants.map((variant) => {
		const artifactPath = variantArtifactPaths.get(variant.tag)!;

		// Variant arrays replace base; variant scalars override base; omitted = inherit
		const prompt = interpolateArtifactPath(variant.prompt ?? raw.prompt, artifactPath);
		const bootstrapProfile = variant.bootstrapProfile ?? raw.bootstrapProfile;
		const expectedSkills = variant.expectedSkills ?? raw.expectedSkills ?? [];
		const disallowedSkills = variant.disallowedSkills ?? raw.disallowedSkills ?? [];
		const expectedRefs = variant.expectedRefs ?? raw.expectedRefs ?? [];
		const skillSet = variant.skillSet ?? raw.skillSet;
		const requireSkillFileRead = variant.requireSkillFileRead ?? raw.requireSkillFileRead ?? false;

		// File assertions: variant replaces base, then interpolate
		const rawFileAssertions = variant.fileAssertions ?? raw.fileAssertions ?? [];
		const fileAssertions = interpolateFileAssertions(rawFileAssertions, artifactPath);

		// Read deny paths: merge base + variant + auto-add sibling artifact paths
		const baseReadDenyPaths = raw.readDenyPaths ?? [];
		const variantReadDenyPaths = variant.readDenyPaths ?? [];
		const siblingPaths = [...variantArtifactPaths.entries()]
			.filter(([tag]) => tag !== variant.tag)
			.map(([, p]) => p);
		const readDenyPaths = interpolateDenyPaths(
			[...baseReadDenyPaths, ...variantReadDenyPaths, ...siblingPaths],
			artifactPath,
		);

		return {
			...raw,
			id: `${bundleId}:${variant.tag}`,
			prompt,
			bootstrapProfile,
			expectedSkills,
			disallowedSkills,
			expectedRefs,
			skillSet,
			requireSkillFileRead,
			fileAssertions,
			readDenyPaths,
			bundleId,
			variantTag: variant.tag,
			variants: undefined,
		};
	});

	const bundle: EvalBundle = { id: bundleId, suite, variantTags };
	return { cases, bundle };
};

const wrapStandalone = (raw: EvalCase): ResolvedEvalCase => ({
	...raw,
	expectedSkills: raw.expectedSkills ?? [],
	disallowedSkills: raw.disallowedSkills ?? [],
	expectedRefs: raw.expectedRefs ?? [],
	sandbox: raw.sandbox ?? true,
	bootstrapProfile: raw.bootstrapProfile ?? (raw.disableHarness ? "no_payload" : "full_payload"),
	requireSkillFileRead: raw.requireSkillFileRead ?? false,
	assertions: raw.assertions ?? [],
	bundleId: null,
	variantTag: null,
});

const parseCasesFromContent = (
	raw: string,
	sourceLabel: string,
	cases: ResolvedEvalCase[],
	bundles: Map<string, EvalBundle>,
): void => {
	const lines = raw.split("\n");
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return;
		try {
			const parsed = JSON.parse(trimmed) as EvalCase;
			if (parsed.variants && Array.isArray(parsed.variants) && parsed.variants.length > 0) {
				const { cases: bundleCases, bundle } = flattenBundle(
					parsed as EvalCase & { variants: EvalCaseVariant[] },
				);
				for (const c of bundleCases) cases.push(c);
				bundles.set(bundle.id, bundle);
			} else {
				cases.push(wrapStandalone(parsed));
			}
		} catch (error) {
			throw new Error(`Failed to parse case in ${sourceLabel} on line ${index + 1}: ${error}`);
		}
	});
};

export const loadCases = async (casesPath: string): Promise<LoadedCases> => {
	const cases: ResolvedEvalCase[] = [];
	const bundles = new Map<string, EvalBundle>();

	const info = await stat(casesPath);
	if (info.isDirectory()) {
		const entries = await readdir(casesPath);
		const jsonlFiles = entries
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		const fileContents = await Promise.all(
			jsonlFiles.map((fileName) => readFile(path.join(casesPath, fileName), "utf-8")),
		);
		for (let i = 0; i < jsonlFiles.length; i++) {
			parseCasesFromContent(fileContents[i], jsonlFiles[i], cases, bundles);
		}
	} else {
		const raw = await readFile(casesPath, "utf-8");
		parseCasesFromContent(raw, casesPath, cases, bundles);
	}

	return { cases, bundles };
};

export const filterCases = (
	loaded: LoadedCases,
	filter?: string,
	limit?: number,
): LoadedCases => {
	let { cases, bundles } = loaded;

	if (filter) {
		const token = filter.toLowerCase();
		// Find matching bundle IDs so we include all their variants
		const matchedBundleIds = new Set<string>();
		for (const [bundleId] of bundles) {
			if (bundleId.toLowerCase().includes(token)) {
				matchedBundleIds.add(bundleId);
			}
		}
		cases = cases.filter((c) => {
			// Include if bundle matched
			if (c.bundleId && matchedBundleIds.has(c.bundleId)) return true;
			// Include if case ID or suite matches
			return c.id.toLowerCase().includes(token) || c.suite.toLowerCase().includes(token);
		});
	}

	if (limit && Number.isFinite(limit)) {
		// Count bundles and standalones as 1 unit each
		const result: ResolvedEvalCase[] = [];
		let unitCount = 0;
		const includedBundles = new Set<string>();

		for (const c of cases) {
			if (c.bundleId) {
				if (!includedBundles.has(c.bundleId)) {
					if (unitCount >= limit) continue;
					includedBundles.add(c.bundleId);
					unitCount++;
				}
				result.push(c);
			} else {
				if (unitCount >= limit) continue;
				result.push(c);
				unitCount++;
			}
		}
		cases = result;
	}

	// Filter bundles map to only include bundles that have cases
	const activeBundleIds = new Set(
		cases.filter((c) => c.bundleId).map((c) => c.bundleId!),
	);
	const filteredBundles = new Map<string, EvalBundle>();
	for (const [id, bundle] of bundles) {
		if (activeBundleIds.has(id)) filteredBundles.set(id, bundle);
	}

	return { cases, bundles: filteredBundles };
};
