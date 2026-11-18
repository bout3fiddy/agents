import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { hostCapability } from './capabilities.ts'

export const roleNames = [
  'orchestrator',
  'design-advisor',
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
    writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
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

export type WorkerResult = Static<typeof resultSchema>
export type Role = {
  name: RoleName
  backend: 'pi' | 'claude-cli'
  prompt: string
  model: string
  thinking: 'low' | 'medium' | 'high'
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
  role: WorkerRole
  task: string
  workspace: string
  project: Project
  checkpoint: Checkpoint
  model: string
  outputPath: string
  baseline: Record<string, string>
  originals?: string
  parentWorkerId?: string
  liveWorkerId?: string
  reviewOf?: string
}

export type WorkerEvidence = {
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

export function validateResult(value: unknown): WorkerResult {
  if (!Check(resultSchema, value)) {
    throw new Error('Invalid worker result')
  }

  if (value.verdict === 'pass' && value.findings.some((item) => item.severity === 'required')) {
    throw new Error('A passing verdict cannot contain required findings')
  }

  return value
}
