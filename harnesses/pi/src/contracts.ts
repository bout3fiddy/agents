import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { hostCapability } from './capabilities.ts'

export const roleNames = [
  'orchestrator',
  'design-advisor',
  'progress-auditor',
  'task-coordinator',
  'branch-orchestrator',
  'task-worker',
  'implementer',
  'reviewer',
  'database-reviewer',
  'performance',
] as const

export type RoleName = (typeof roleNames)[number]
export type WorkerRole = Exclude<
  RoleName,
  'orchestrator' | 'design-advisor' | 'task-coordinator' | 'branch-orchestrator'
>

export const thinkingSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
])
export const specialistThinkingSchema = Type.Union([Type.Literal('medium'), Type.Literal('high')])
export const workflowSpecialistsSchema = Type.Object(
  {
    reviewer: Type.Optional(specialistThinkingSchema),
    'database-reviewer': Type.Optional(specialistThinkingSchema),
    performance: Type.Optional(specialistThinkingSchema),
  },
  { additionalProperties: false },
)
export type WorkerThinking = Static<typeof thinkingSchema>

export const writePathSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description: 'Use an exact relative filename, directory/** for a subtree, or ** for all paths.',
})

export const designSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 2000 }),
    design: Type.String({ minLength: 1, maxLength: 16000 }),
    invariants: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 30,
    }),
    acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 30,
    }),
    writePaths: Type.Array(writePathSchema, {
      minItems: 1,
      maxItems: 50,
    }),
    database: Type.Boolean(),
    performance: Type.Boolean(),
    unresolved: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
)

export type Design = Static<typeof designSchema>
export type Checkpoint = Design & { version: number; hash: string; acceptedAt: string }

export const resultSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal('pass'), Type.Literal('changes'), Type.Literal('blocked')]),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    findings: Type.Array(
      Type.Object(
        {
          severity: Type.Union([Type.Literal('required'), Type.Literal('suggestion')]),
          location: Type.String({ maxLength: 300 }),
          formatterPath: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 300,
              description:
                'Exact path only if pinned formatting alone resolves this entire finding.',
            }),
          ),
          problem: Type.String({ minLength: 1, maxLength: 1500 }),
          evidence: Type.String({ minLength: 1, maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 30 },
    ),
    databaseImpact: Type.Boolean(),
    evidence: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 30 }),
    hostActions: Type.Optional(
      Type.Array(
        Type.Object({
          capability: hostCapability,
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
        }),
        { maxItems: 8 },
      ),
    ),
  },
  { additionalProperties: false },
)

export class ProviderQuotaError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message)
  }
}

export const auditResultSchema = Type.Object(
  {
    ...resultSchema.properties,
    continuation: Type.Object(
      {
        action: Type.Union([Type.Literal('continue'), Type.Literal('stop')]),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type WorkerResult = Static<typeof resultSchema> & {
  continuation?: Static<typeof auditResultSchema>['continuation']
}
export type Role = {
  name: RoleName
  backend: 'pi' | 'claude-cli'
  prompt: string
  model: string
  thinking: WorkerThinking
  skills: string[]
  tools: string[]
  writes: string[]
  mayDelegate: boolean
}

export type CommandResult = {
  argv: string[]
  exitCode: number | null
  output: string
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  durationMs: number
}

export type ProjectCheck = {
  id: string
  argv: string[]
  required: boolean
  kind: 'test' | 'database' | 'benchmark' | 'static'
  timeoutMs: number
}

export type Project = {
  root: string
  checks: ProjectCheck[]
  instrumentationPaths: string[]
  databasePaths: string[]
  nodeModules?: string
}

export type Receipt = {
  snapshot: string
  check: string
  status: 'passed' | 'failed' | 'skipped' | 'unavailable'
  result: CommandResult
}

export type WorkerRequest = {
  decideContinuation?: boolean
  thinking?: Role['thinking']
  role: WorkerRole
  task: string
  workspace: string
  project: Project
  checkpoint: Checkpoint
  model: string
  outputPath: string
  baseline: Record<string, string>
  originals?: string
  changedFiles?: string[]
  documentsOnly?: boolean
  parentWorkerId?: string
  liveWorkerId?: string
  reviewOf?: string
}

export type WorkerEvidence = {
  formatterProof?: { path: string; before: string; after: string }[]
  closedReview?: { snapshot: string; model: string; paths: string[] }
  thinking?: string
  liveWorkerId?: string
  role: WorkerRole
  snapshot: string
  result: WorkerResult
  commands: CommandResult[]
  turns: number
  model: string
}

export function validateDesign(value: unknown): Design {
  if (!Check(designSchema, value)) {
    throw new Error(
      'Invalid design: provide bounded objective, design, invariants, ' + 'criteria and scope',
    )
  }

  return value
}

/** Read-only reports may complete while identifying required changes in the subject. */
export function completedResult(verdict: WorkerResult['verdict'], readOnlyReport: boolean) {
  return verdict === 'pass' || (readOnlyReport && verdict === 'changes')
}

export function validateResult(value: unknown, decideContinuation = false): WorkerResult {
  if (!Check(decideContinuation ? auditResultSchema : resultSchema, value)) {
    throw new Error('Invalid worker result')
  }

  if (value.verdict === 'pass' && value.findings.some((item) => item.severity === 'required')) {
    throw new Error('A passing verdict cannot contain required findings')
  }

  return value
}
