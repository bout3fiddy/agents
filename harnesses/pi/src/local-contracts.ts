import { Type, type Static } from 'typebox'
import {
  implementerModelSchema,
  taskTitleSchema,
  thinkingSchema,
  writePathSchema,
  type ProjectCheck,
} from './contracts.ts'

const paths = Type.Array(writePathSchema, { minItems: 1, maxItems: 30 })
const acceptance = Type.Object(
  {
    argv: Type.Array(Type.String({ maxLength: 4000 }), { minItems: 1, maxItems: 100 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 900000 })),
    workloadPaths: Type.Optional(paths),
  },
  { additionalProperties: false },
)

export const localBatchSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal('independent'), Type.Literal('competition')], {
        description:
          'Default independent. Reserve competition for a difficult unresolved tradeoff.',
      }),
    ),
    comparison: Type.Optional(
      Type.Object(
        {
          difficulty: Type.String({
            minLength: 1,
            maxLength: 800,
            description: 'What makes a single implementation insufficient here?',
          }),
          criterion: Type.String({
            minLength: 1,
            maxLength: 800,
            description: 'What observable result distinguishes the viable approaches?',
          }),
        },
        { additionalProperties: false },
      ),
    ),
    objective: Type.String({ minLength: 1, maxLength: 2000 }),
    acceptance: Type.Optional(acceptance),
    tasks: Type.Array(
      Type.Object(
        {
          task: Type.String({ minLength: 1, maxLength: 2000 }),
          title: Type.Optional(taskTitleSchema),
          writePaths: paths,
          acceptance: Type.Optional(acceptance),
          thinking: Type.Optional(thinkingSchema),
          implementerModel: Type.Optional(implementerModelSchema),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
)

export type LocalBatch = Static<typeof localBatchSchema>
export type LocalPlan = {
  batch: string
  mode: NonNullable<LocalBatch['mode']>
  comparison?: LocalBatch['comparison']
  base: string
  targetRef: string
  objective: string
  acceptance: ProjectCheck
  workloadPaths: string[]
}

export type LocalTaskInput = Omit<LocalBatch['tasks'][number], 'acceptance'> & {
  context: string
  local: LocalPlan
  branch?: never
}

export function competingSiblings(left?: LocalPlan, right?: LocalPlan): boolean {
  return left?.mode === 'competition' && right?.mode === 'competition' && left.batch === right.batch
}
