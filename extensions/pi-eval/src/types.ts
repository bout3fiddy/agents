export type FileAssertion = {
	path: string;
	mustContain?: string[];
	mustNotContain?: string[];
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

export type CaseTimings = {
	spawnToFirstEventMs?: number | null;
	promptToAgentEndMs?: number[];
	agentEndToOutputMs?: number | null;
	shutdownMs?: number | null;
	totalMs?: number | null;
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
	timings?: CaseTimings;
};

export type CaseEvaluation = {
	caseId: string;
	suite: string;
	mode: "single" | "baseline" | "interference";
	status: "pass" | "fail";
	reasons: string[];
	result: CaseRunResult;
	expectedSkills: string[];
	disallowedSkills: string[];
	expectedRefs: string[];
	assertions: string[];
	tokenBudget?: number | null;
};

export type MatrixEvaluation = {
	evalCase: EvalCase;
	baseline: CaseEvaluation;
	interference: CaseEvaluation;
	deltaSummary: string;
};
