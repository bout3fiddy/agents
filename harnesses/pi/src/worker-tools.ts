import { rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  auditResultSchema,
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
import { fileHashes, inventory, snapshotPath, writable } from './paths.ts'
import { checkDocuments } from './document-tools.ts'
import { capabilities } from './capabilities.ts'
import { atomicJson } from './state.ts'

import { formatSource } from './formatter-review.ts'

export const references: Record<string, string> = {
  benchmarking: 'skills/zig/references/benchmarking.md',
  allocation: 'skills/zig/references/allocation-evidence.md',
  compiler: 'skills/zig/references/compiler-evidence.md',
  machine: 'skills/zig/references/machine-level-hypotheses.md',
  housekeeping: 'skills/housekeeping/SKILL.md',
  'readability-spacing': 'harnesses/pi/scripts/linting/readability.mjs',
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
  const tools: ToolDefinition[] = fileTools(
    request.workspace,
    writeScopes,
    roleScopes,
    request.documentsOnly,
    snapshotPath,
  )

  if (request.originals) {
    const originalRead = fileTools(
      request.originals,
      undefined,
      undefined,
      false,
      snapshotPath,
    ).find((tool) => tool.name === 'project_read')!
    tools.push({
      ...originalRead,
      name: 'original_read',
      label: 'Read original file',
      description:
        'Read the original snapshot before implementation. Same paging and folder rules ' +
        'as project_read.',
    })
  }

  if (writeScopes) {
    tools.push({
      name: 'project_format',
      executionMode: 'sequential',
      label: 'Format assigned files',
      description:
        'Format assigned Prettier-supported files. For JS/TS this applies the exact harness ' +
        'spacing rule (read_reference: readability-spacing). Check line widths separately. ' +
        'For Python use scoped edits and project checks.',
      parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }),
      async execute(_id, raw) {
        const { paths } = raw as { paths: string[] }

        const edits = []

        for (const path of paths) {
          if (!writable(path, writeScopes, request.documentsOnly) || !writable(path, roleScopes)) {
            throw new Error('Format path is outside the assignment')
          }

          const target = await snapshotPath(request.workspace, path)
          const source = await readFile(target, 'utf8')
          const formatted = await formatSource(source, path)
          edits.push({ target, content: formatted })
        }

        for (const edit of edits) {
          await writeFile(edit.target, edit.content)
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
      executionMode: writeScopes ? 'sequential' : 'parallel',
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
            paths.some(
              (path) =>
                !writable(path, writeScopes, request.documentsOnly) || !writable(path, roleScopes),
            ))
        ) {
          throw new Error('Document formatting is outside this worker assignment')
        }

        for (const path of paths) {
          await snapshotPath(request.workspace, path)
        }

        const result = await checkDocuments(request.workspace, paths, shouldFormat)
        return { ...textResult(result), isError: result.status === 'failed' }
      },
    },
    {
      name: 'run_command',
      label: 'Run isolated command',
      description:
        'Call run_command directly for shell commands and tests, including independent checks. ' +
        'Run isolated argv. npm/npx use installed tools or offline cache. ' +
        'Preserve each check’s exit status when grouping commands or filtering output. ' +
        'No network/home access. Retain edits with project_edit/project_write.',
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
        'Read canonical engineering references, including the executable JS/TS spacing rule.',
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
      parameters: request.decideContinuation ? auditResultSchema : resultSchema,
      async execute(id, raw) {
        submitted = validateResult(raw, request.decideContinuation)
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

async function changedSinceBaseline(request: WorkerRequest): Promise<string[]> {
  const current = fileHashes(await inventory(request.workspace))
  const names = new Set([...Object.keys(request.baseline), ...Object.keys(current)])
  return [...names].filter((name) => current[name] !== request.baseline[name]).sort()
}

export async function assignment(request: WorkerRequest) {
  const paths = Object.keys(request.baseline)
  const smallIndex = paths.length <= 100 && Buffer.byteLength(JSON.stringify(paths)) <= 4096

  return {
    assignment: request.task,
    acceptedDesign: request.checkpoint,
    changedFiles: request.changedFiles ?? (await changedSinceBaseline(request)),
    ...(smallIndex ? { originalPaths: paths } : {}),
    checks: request.project.checks,
    capabilities: capabilities.workers,
    ...(request.documentsOnly ? { retainedFileTypes: ['.md', '.txt', '.rst'] } : {}),
    folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
    output:
      request.role === 'progress-auditor'
        ? 'Submit a dated scorecard with evidence and identify missing proof.'
        : 'Use submit_result when finished. If a host capability is required, return blocked ' +
          'with hostActions immediately. Do not retry unavailable operations in the sandbox.',
  }
}
