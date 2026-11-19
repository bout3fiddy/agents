import { Type, type Static } from 'typebox'
import {
  implementerModelSchema,
  taskTitleSchema,
  thinkingSchema,
  type WorkerThinking,
  writePathSchema,
  type Design,
  type Project,
} from './contracts.ts'

export const branchTaskSchema = Type.Object(
  {
    title: Type.Optional(taskTitleSchema),
    implementerModel: Type.Optional(implementerModelSchema),
    thinking: Type.Optional(thinkingSchema),
    task: Type.String({ minLength: 1, maxLength: 2000 }),
    writePaths: Type.Array(writePathSchema, {
      minItems: 1,
      maxItems: 30,
    }),
    invariants: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 30,
    }),
    acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 30,
    }),
    database: Type.Boolean(),
    performance: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const fanoutSchema = Type.Object(
  {
    designPath: Type.String({ minLength: 1, maxLength: 200 }),
    tasks: Type.Array(branchTaskSchema, { minItems: 1, maxItems: 4 }),
    remote: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' })),
    mergeToMain: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export type FanoutInput = Static<typeof fanoutSchema>
export type BranchPlan = {
  batch: string
  remote: string
  target: 'main'
  remoteUrl: string
  base: string
  designPath: string
  designHash: string
  design: Design
  mergeToMain?: boolean
}

export function pinnedDesignInstruction(path: string, hash: string) {
  return `Read the settled design at ${path} with original_read, paging as needed. SHA-256: ${hash}`
}

export type BranchTaskInput = {
  title?: string
  implementerModel?: Static<typeof implementerModelSchema>
  thinking?: WorkerThinking
  task: string
  context: string
  writePaths: string[]
  branch: BranchPlan
}

export function requireBranchChecks(
  project: Project,
  scope: Pick<Design, 'database' | 'performance'>,
) {
  const kinds = [
    'test',
    ...(scope.database ? ['database'] : []),
    ...(scope.performance ? ['benchmark'] : []),
  ]
  const missing = kinds.filter(
    (kind) => !project.checks.some((check) => check.required && check.kind === kind),
  )

  if (missing.length) {
    throw new Error(
      `Missing required ${missing.join(', ')} check on pinned main. ` +
        'Use executable npm scripts or declare the commands in .pi/harness.json. ' +
        'Dispatch independent tasks with available checks separately.',
    )
  }
}
