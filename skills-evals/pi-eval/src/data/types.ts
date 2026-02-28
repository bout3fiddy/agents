export type FileAssertion = {
	path: string;
	mustContain?: string[];
	mustNotContain?: string[];
	maxNonEmptyLines?: number;
};

export type BootstrapProfile = "full_payload" | "no_payload";

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
	bootstrapProfile?: BootstrapProfile;
	requireSkillFileRead?: boolean;
	disableHarness?: boolean;
	dryRun?: boolean;
	tokenBudget?: number | null;
	assertions?: string[];
	notes?: string;
	persistArtifacts?: boolean;
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
	skillFileInvocations?: string[];
	skillFileAttempts?: string[];
	refInvocations: string[];
	refAttempts: string[];
	outputText: string;
	tokens: TokenUsage;
	durationMs: number;
	errors: string[];
	bootstrapProfile?: BootstrapProfile;
	availableSkills?: string[];
	bootstrapManifestHash?: string | null;
	workspaceDir?: string | null;
};

export type FailureCategory =
	| "BOOTSTRAP_FAILURE"
	| "POLICY_FAILURE"
	| "ROUTING_FAILURE"
	| "TASK_FAILURE";

export type FailureReason = {
	category: FailureCategory;
	message: string;
};

export type RoutingScorecard = {
	readSkills: string[];
	readSkillFiles: string[];
	readRefs: string[];
	missingSkillFileReads: string[];
	missingRefs: string[];
	unexpectedRefs: string[];
};

export type CaseEvaluation = {
	caseId: string;
	suite: string;
	mode: "single";
	status: "pass" | "fail";
	reasons: string[];
	failureReasons: FailureReason[];
	result: CaseRunResult;
	expectedSkills: string[];
	disallowedSkills: string[];
	expectedRefs: string[];
	routing: RoutingScorecard;
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
