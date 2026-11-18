import { rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  resultSchema,
  validateResult,
  type CommandResult,
  type WorkerRequest,
  type WorkerResult,
  type Role,
} from './contracts.ts'
import { fileTools, textResult } from './file-tools.ts'
import { createWorkspace, harnessRoot, instructions } from './project.ts'
import { runSandboxed } from './sandbox.ts'
import { safePath, writable } from './paths.ts'
import { format } from 'prettier'
import { checkDocuments } from './document-tools.ts'
import { capabilities } from './capabilities.ts'
import { atomicJson } from './state.ts'

// @ts-expect-error Shared formatting code is JavaScript.
import { addReadabilitySpacing } from '../scripts/linting/readability.mjs'

export const references: Record<string, string> = {
  benchmarking: 'skills/zig/references/benchmarking.md',
  allocation: 'skills/zig/references/allocation-evidence.md',
  compiler: 'skills/zig/references/compiler-evidence.md',
  machine: 'skills/zig/references/machine-level-hypotheses.md',
  housekeeping: 'skills/housekeeping/SKILL.md',
}

export function createWorkerTools(request: WorkerRequest, role: Role) {
  const commands: CommandResult[] = []
  let submitted: WorkerResult | undefined
  const writeScopes = ['implementer', 'performance', 'task-worker'].includes(request.role)
    ? request.checkpoint.writePaths
    : undefined
  const roleScopes =
    request.role === 'performance'
      ? [...role.writes, ...request.project.instrumentationPaths]
      : role.writes
  const tools: ToolDefinition[] = fileTools(request.workspace, writeScopes, roleScopes)

  if (request.originals) {
    const originalRead = fileTools(request.originals).find((tool) => tool.name === 'project_read')!
    tools.push({
      ...originalRead,
      name: 'original_read',
      label: 'Read original file',
      description:
        'Read the original snapshot before implementation; compare it ' + 'with project_read.',
    })
  }

  if (writeScopes) {
    tools.push({
      name: 'project_format',
      label: 'Format assigned files',
      description: 'Apply 100-column formatting and AST readability spacing to assigned files.',
      parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }),
      async execute(_id, raw) {
        const { paths } = raw as { paths: string[] }

        for (const path of paths) {
          if (!writable(path, writeScopes) || !writable(path, roleScopes)) {
            throw new Error('Format path is outside the assignment')
          }

          const target = await safePath(request.workspace, path)
          const source = await readFile(target, 'utf8')
          const formatted = await format(source, {
            filepath: path,
            printWidth: 100,
            semi: false,
            singleQuote: true,
            trailingComma: 'all',
            proseWrap: 'always',
          })
          await writeFile(target, addReadabilitySpacing(formatted, path))
        }

        return textResult({ formatted: paths })
      },
    })
  }

  tools.push(
    {
      name: 'report_progress',
      label: 'Report meaningful progress',
      description:
        'Update a concise summary after a meaningful finding, phase change or blocker. ' +
        'Do not call every turn. This updates private status without interrupting discussion.',
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 400 }) }),
      async execute(_id, raw) {
        const { summary } = raw as { summary: string }
        await atomicJson(`${request.outputPath}.summary.json`, {
          summary,
          updatedAt: new Date().toISOString(),
        })
        return textResult({ recorded: true })
      },
    },
    {
      name: 'document_check',
      label: 'Check assigned Markdown documents',
      description:
        'Check Markdown formatting and line width. Respect root .prettierignore for formatting. ' +
        'Formatting requires write scope.',
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { minItems: 1, maxItems: 24 }),
        format: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, raw) {
        const { paths, format: shouldFormat = false } = raw as {
          paths: string[]
          format?: boolean
        }

        if (
          shouldFormat &&
          (!writeScopes ||
            paths.some((path) => !writable(path, writeScopes) || !writable(path, roleScopes)))
        ) {
          throw new Error('Document formatting is outside this worker assignment')
        }

        const result = await checkDocuments(request.workspace, paths, shouldFormat)
        return { ...textResult(result), isError: result.status === 'failed' }
      },
    },
    {
      name: 'run_command',
      label: 'Run isolated command',
      description:
        'Run isolated argv. No network/home access. Retain edits with project_edit/project_write.',
      parameters: Type.Object({
        argv: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      async execute(id, raw, signal) {
        const { argv, timeoutMs } = raw as { argv: string[]; timeoutMs?: number }
        const probe = await createWorkspace(request.workspace)

        try {
          const result = await runSandboxed(probe, argv, timeoutMs, signal)
          commands.push(result)
          return textResult({ ...result, call: id })
        } finally {
          await rm(probe, { recursive: true, force: true })
        }
      },
    },
    {
      name: 'read_reference',
      label: 'Read engineering reference',
      description:
        'Read canonical benchmarking, allocation, compiler, machine or ' + 'housekeeping guidance.',
      parameters: Type.Object({
        name: Type.Union(Object.keys(references).map((name) => Type.Literal(name))),
      }),
      async execute(_id, raw) {
        const { name } = raw as { name: string }
        const path = references[name]

        if (!path) {
          throw new Error('Unknown reference')
        }

        return textResult(await readFile(join(harnessRoot, '../..', path), 'utf8'))
      },
    },
    {
      name: 'submit_result',
      label: 'Submit worker result',
      description: 'Submit a verdict and evidence. Required findings prevent pass.',
      parameters: resultSchema,
      async execute(id, raw) {
        submitted = validateResult(raw)
        return textResult({ submitted: true, call: id })
      },
    },
  )
  return {
    tools: tools.filter((tool) => role.tools.includes(tool.name)),
    commands,
    result: () => submitted,
    invalidateResult: () => {
      submitted = undefined
    },
  }
}

export async function assignment(request: WorkerRequest) {
  return {
    assignment: request.task,
    acceptedDesign: request.checkpoint,
    originalFileHashes: request.baseline,
    checks: request.project.checks,
    capabilities: capabilities.workers,
    folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
    output:
      'Use submit_result when finished. If a host capability is required, return blocked ' +
      'with hostActions immediately. Do not retry unavailable operations in the sandbox.',
  }
}
