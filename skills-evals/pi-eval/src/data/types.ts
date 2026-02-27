export type FileAssertion = {
	path: string;
	mustContain?: string[];
	mustNotContain?: string[];
	maxNonEmptyLines?: number;
};

export type EvalCase = {
	id: string;
	suite: string;
	prompt: string;
	turns?: string[];
	expectedSkills: string[];
	disallowedSkills: string[];
	expectedRefs: string[];
	skillSet?: string[];
	tools?: string[];
	sandbox?: boolean;
	fileAssertions?: FileAssertion[];
	readDenyPaths?: string[];
	disableHarness?: boolean;
	dryRun?: boolean;
	tokenBudget?: number | null;
	assertions?: string[];
	notes?: string;
};

export type EvalConfig = {
	requiredModels: string[];
	models?: Record<string, { globalInstructions: string[] }>;
	defaults?: {
		agentDir?: string;
		skillsPaths?: string[];
		dryRun?: boolean;
	};
};

export type SkillInfo = {
	name: string;
	description?: string;
	skillDir: string;
	skillFile: string;
};

export type ModelSpec = {
	provider: string;
	id: string;
	key: string;
	label: string;
};

export type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type CaseRunResult = {
	caseId: string;
	dryRun: boolean;
	model: ModelSpec | null;
	skillInvocations: string[];
	skillAttempts: string[];
	refInvocations: string[];
	refAttempts: string[];
	outputText: string;
	tokens: TokenUsage;
	durationMs: number;
	errors: string[];
	workspaceDir?: string | null;
};

export type CaseEvaluation = {
	caseId: string;
	suite: string;
	mode: "single";
	status: "pass" | "fail";
	reasons: string[];
	result: CaseRunResult;
	expectedSkills: string[];
	disallowedSkills: string[];
	expectedRefs: string[];
	assertions: string[];
	tokenBudget?: number | null;
};

export type EvalRunOptions = {
	agentDir: string;
	model: ModelSpec;
	casesPath: string;
	defaultCasesPath: string;
	filter?: string;
	limitOverride?: number;
	dryRunOverride: boolean;
	thinkingLevel: string;
	caseParallelism: number;
	evalAuthSource: string | null;
	isFullRun: boolean;
	casesPathLabel: string;
};
