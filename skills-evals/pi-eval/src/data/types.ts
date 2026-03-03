export type FileAssertion = {
	path: string;
	mustContain?: string[];
	mustNotContain?: string[];
	maxNonEmptyLines?: number;
};

export type BootstrapProfile = "full_payload" | "no_payload";

export type EvalCaseVariant = {
	tag: string;
	prompt?: string;
	bootstrapProfile?: BootstrapProfile;
	expectedSkills?: string[];
	disallowedSkills?: string[];
	expectedRefs?: string[];
	skillSet?: string[];
	requireSkillFileRead?: boolean;
	fileAssertions?: FileAssertion[];
	readDenyPaths?: string[];
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
	bootstrapProfile?: BootstrapProfile;
	requireSkillFileRead?: boolean;
	disableHarness?: boolean;
	dryRun?: boolean;
	tokenBudget?: number | null;
	assertions?: string[];
	notes?: string;
	persistArtifacts?: boolean;
	variants?: EvalCaseVariant[];
};

export type ResolvedEvalCase = EvalCase & {
	bundleId: string | null;
	variantTag: string | null;
};

export type EvalBundle = {
	id: string;
	suite: string;
	variantTags: string[];
};

export type LoadedCases = {
	cases: ResolvedEvalCase[];
	bundles: Map<string, EvalBundle>;
};

export type EvalConfig = {
	requiredModels: string[];
	models?: Record<string, { globalInstructions: string[] }>;
	defaults?: {
		agentDir?: string;
		dryRun?: boolean;
	};
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

export type TurnTokenUsage = {
	turn: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type ToolUsageSummary = {
	allowedTools: string[];
	writeCalls: number;
	editCalls: number;
	writeFailures: number;
	editFailures: number;
};

export type RpcToolCallDiagnostics = {
	id: string;
	toolName: string;
	startCount: number;
	deltaCount: number;
	endCount: number;
	executionStartCount: number;
	executionEndCount: number;
	executionSuccessCount: number;
	executionFailureCount: number;
	maxPartialJsonLength: number;
	seenInAgentEnd: boolean;
};

export type RpcDiagnostics = {
	rawLineCount: number;
	parsedEventCount: number;
	parseErrorCount: number;
	eventCounts: Record<string, number>;
	autoRetryStartCount: number;
	autoRetryEndCount: number;
	terminalAgentErrorCount: number;
	lastAgentStopReason: string | null;
	lastAgentErrorMessage: string | null;
	toolCalls: RpcToolCallDiagnostics[];
	anomalies: string[];
};

export type ReadBreakdownEntry = {
	path: string;
	category: "skill" | "ref" | "task";
	bytes: number;
	estTokens: number;
};

export type BootstrapBreakdownEntry = {
	path: string;
	bytes: number;
};

export type CaseRunResult = {
	caseId: string;
	dryRun: boolean;
	model: ModelSpec | null;
	workerReady?: boolean;
	skillInvocations: string[];
	skillAttempts: string[];
	skillDenied?: string[];
	skillFileInvocations?: string[];
	skillFileAttempts?: string[];
	skillFileDenied?: string[];
	refInvocations: string[];
	refAttempts: string[];
	refDenied?: string[];
	outputText: string;
	tokens: TokenUsage;
	durationMs: number;
	errors: string[];
	bootstrapProfile?: BootstrapProfile;
	availableSkills?: string[];
	bootstrapManifestHash?: string | null;
	workspaceDir?: string | null;
	toolUsage?: ToolUsageSummary;
	rpcDiagnostics?: RpcDiagnostics;
	readBreakdown?: ReadBreakdownEntry[];
	bootstrapBreakdown?: BootstrapBreakdownEntry[];
	turnBreakdown?: TurnTokenUsage[];
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
	attemptedSkills?: string[];
	successfulSkills?: string[];
	deniedSkills?: string[];
	attemptedSkillFiles?: string[];
	successfulSkillFiles?: string[];
	deniedSkillFiles?: string[];
	attemptedRefs?: string[];
	successfulRefs?: string[];
	deniedRefs?: string[];
	missingSkillFileReads: string[];
	missingRefs: string[];
	unexpectedRefs: string[];
};

export type JudgeDimensionScore = {
	name: string;
	scores: Record<string, number>;
	rationale: string;
};

export type JudgeBundleVerdict = {
	bundleId: string;
	variantTags: string[];
	dimensions: JudgeDimensionScore[];
	costAnalysis: string;
	recommendation: string;
	rawResponse: string;
	judgeTokens: TokenUsage;
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
	judgeVerdict?: JudgeBundleVerdict;
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
	judgeModel: ModelSpec | null;
	judgeThinking: string;
	judgeDisabled: boolean;
};
