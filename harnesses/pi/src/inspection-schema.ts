import { Type } from 'typebox'
import { designSchema, resultSchema } from './contracts.ts'

const string = Type.String()
const optional = Type.Optional(string)
const strings = Type.Array(string)
const open = { additionalProperties: true }
const check = Type.Object({ check: string, status: string, snapshot: string }, open)

export const taskStatusSchema = Type.Object(
  {
    id: string,
    kind: string,
    status: string,
    state: string,
    updatedAt: string,
    task: string,
    writePaths: strings,
    auditRequired: Type.Optional(Type.Array(Type.Object({ location: string, problem: string }))),
    branch: optional,
    commit: optional,
    candidate: optional,
    pullRequest: optional,
    summary: optional,
    error: optional,
    health: optional,
    checks: Type.Optional(Type.Array(check)),
    hostActions: resultSchema.properties.hostActions,
    progress: Type.Optional(Type.Object({ stage: optional, message: optional }, open)),
    children: Type.Optional(
      Type.Array(Type.Object({ role: string, model: string, verdict: string }, open)),
    ),
  },
  open,
)

export const capabilitySchema = Type.Object({
  host: Type.Object({
    shell: string,
    tasks: strings,
    localImplementation: string,
    authority: string,
  }),
  workers: Type.Object({
    shell: string,
    writes: string,
    dependencies: string,
    git: string,
    failure: string,
  }),
  routing: string,
})

export const harnessStatusSchema = Type.Object({
  artifacts: string,
  capabilities: capabilitySchema,
  delegations: Type.Array(taskStatusSchema),
  runtime: Type.Optional(Type.Object({ version: string, revision: string, loadId: string }, open)),
  checkpoint: Type.Optional(
    Type.Object({ ...designSchema.properties, version: Type.Integer(), hash: string }, open),
  ),
  task: Type.Optional(
    Type.Object(
      {
        id: string,
        status: string,
        phase: string,
        round: Type.Integer(),
        error: optional,
        candidate: optional,
        checks: Type.Array(check),
        roles: Type.Array(
          Type.Object({
            role: string,
            model: string,
            verdict: string,
            summary: string,
            requiredFindings: Type.Array(
              Type.Object({
                location: string,
                problem: string,
              }),
            ),
          }),
        ),
      },
      open,
    ),
  ),
})
