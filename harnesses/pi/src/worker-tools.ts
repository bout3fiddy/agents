import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  auditResultSchema,
  implementerResultSchema,
  resultSchema,
  validateResult,
  type CommandResult,
  type WorkerRequest,
  type WorkerResult,
  type Role,
} from './contracts.ts'
import { fileTools, textResult } from './file-tools.ts'
import { createWorkspace, harnessRoot, instructions } from './project.ts'
import { addGitIndex } from './probe-git.ts'
import { fileHashes, inventory, safePath, snapshotPath, writable } from './paths.ts'
import { checkDocuments } from './document-tools.ts'
import { workerCapabilities } from './capabilities.ts'
import { atomicJson } from './state.ts'
import {
  effectiveExecution,
  isolationUnavailable,
  linkLockedDependencies,
  runWorkerCommand,
  storedExecution,
  type ExecutionMode,
} from './worker-execution.ts'

import { verificationLoopSchema, verifyLoop } from './verification-loop.ts'
import { formatSource } from './source-format.ts'

export const references: Record<string, string> = {
  benchmarking: 'skills/zig/references/benchmarking.md',
  allocation: 'skills/zig/references/allocation-evidence.md',
  compiler: 'skills/zig/references/compiler-evidence.md',
  machine: 'skills/zig/references/machine-level-hypotheses.md',
  housekeeping: 'skills/housekeeping/SKILL.md',
  'readability-spacing': 'harnesses/pi/scripts/linting/readability.mjs',
}

const commandGuidance =
  'Call run_command directly for shell commands and tests, including independent checks. ' +
  'Preserve each check’s exit status when grouping commands or filtering output. ' +
  'The copy has a Git index and HEAD for read-only git commands. ' +
  'Retain edits with project_edit/project_write. '

/** Describe the command tool for the decision frozen at dispatch. Each result also reports the
 * mode and runner actually used, which can only be more isolated. */
function commandDescription(mode: ExecutionMode): string {
  return mode === 'trusted-local'
    ? commandGuidance +
        'Runs argv as a normal local command in a disposable copy of the candidate: installed ' +
        'dependencies, loopback and network behave as in the trusted checkout. Write temporary ' +
        'files under $TMPDIR. Writes in the copy are discarded, and changes to candidate paths ' +
        'outside the assignment are undone. Do not install dependencies or change other files.'
    : commandGuidance +
        'Run isolated argv. npm/npx use installed tools or offline cache. ' +
        'No network/home access; write temporary files under $TMPDIR, since /tmp is denied.'
}

/** A trusted-local command has the user's file authority, so it can reach the candidate by
 * absolute path. Undo what it changed outside the assignment: only scoped file tools retain
 * edits. Paths excluded from snapshots are not observed. Returns the restored paths.
 *
 * This attributes every change during the command to the command, as the coordinator's own
 * write check does for a child. It is correct only while one worker at a time holds a candidate:
 * the coordinator runs children serially and each local or branch candidate has its own
 * worktree. Running workers concurrently on one candidate would let this revert a sibling's
 * edit, so that change must replace this step first. */
async function restoreUnassigned(
  workspace: string,
  before: Map<string, Buffer>,
  assigned: (path: string) => boolean,
): Promise<string[]> {
  const after = await inventory(workspace)
  const restored: string[] = []

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const original = before.get(name)
    const current = after.get(name)
    const unchanged = original ? current?.equals(original) : !current

    if (unchanged || assigned(name)) {
      continue
    }

    const target = await safePath(workspace, name)

    if (original) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, original)
    } else {
      await rm(target, { force: true })
    }

    restored.push(name)
  }

  return restored.sort()
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
  const assigned = (path: string) => {
    try {
      return (
        writeScopes !== undefined &&
        writable(path, writeScopes, request.documentsOnly) &&
        writable(path, roleScopes)
      )
    } catch {

      // A name the scope rules reject outright is never part of an assignment.
      return false
    }
  }

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
      name: 'verify_loop',
      executionMode: 'sequential',
      label: 'Run verification loop',
      description:
        'Run isolated seeded cases in one call. Use {seed} in argv. Differential compares ' +
        'stable text from original and candidate. Benchmark runs matching inputs in alternating ' +
        'order; emit one numeric value and specify metric with unit. Return first failing replay ' +
        'or paired medians. Raw samples are retained. Project acceptance checks remain required.',
      parameters: verificationLoopSchema,
      async execute(_id, input, signal) {
        const execution = await effectiveExecution(request.project)
        const before =
          execution.mode === 'trusted-local' ? await inventory(request.workspace) : undefined
        const result = await verifyLoop(request, input, signal)
        const restored = before ? await restoreUnassigned(request.workspace, before, assigned) : []
        return {
          ...textResult({
            ...result,
            ...(restored.length > 0 && { restoredCandidatePaths: restored }),
          }),
          isError: result.status !== 'passed' || restored.length > 0,
        }
      },
    },
    {
      name: 'run_command',
      label: 'Run command',
      description: commandDescription(storedExecution(request.project.execution).mode),

      // The mode is not a parameter: it comes from the host's decision alone.
      parameters: Type.Object({
        argv: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      async execute(id, raw, signal) {
        const { argv, timeoutMs } = raw as { argv: string[]; timeoutMs?: number }
        const execution = await effectiveExecution(request.project)
        const files = await inventory(request.workspace)
        const probe = await createWorkspace(request.workspace, files)

        try {
          const root = request.project.root
          const git = await addGitIndex(probe, request.workspace, root)
          const linked = await linkLockedDependencies(probe, root, files.keys(), execution)
          const result = await runWorkerCommand(execution, {
            workspace: probe,
            argv,
            timeoutMs,
            signal,
            readable: [...git, ...linked],
          })
          commands.push(result)
          const restored =
            execution.mode === 'trusted-local'
              ? await restoreUnassigned(request.workspace, files, assigned)
              : []
          return {
            ...textResult({
              ...result,
              execution: execution.mode,
              ...(isolationUnavailable(result) && {
                isolation: 'The sandbox could not start. The command did not run on the host.',
              }),
              ...(restored.length > 0 && { restoredCandidatePaths: restored }),
              call: id,
            }),
            ...(restored.length > 0 && { isError: true }),
          }
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
      parameters:
        role.name === 'implementer'
          ? implementerResultSchema
          : request.decideContinuation
            ? auditResultSchema
            : resultSchema,
      async execute(id, raw) {
        const result = validateResult(raw, request.decideContinuation)

        if (role.name === 'implementer') {
          const review = result.engineeringReview

          if (review && 'unscored' in review.testing && result.verdict !== 'blocked') {
            const files = request.changedFiles ?? (await changedSinceBaseline(request))

            if (!files.length || !files.every((file) => /\.(?:md|rst|txt)$/i.test(file))) {
              throw new Error('Score behavioral changes. Unscored is for blocked or prose reviews.')
            }
          }
        }

        submitted = result
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

function submissionInstructions(role: WorkerRequest['role']) {
  if (role === 'progress-auditor') {
    return 'Submit a dated scorecard with evidence and identify missing proof.'
  }

  if (role === 'implementer') {
    return (
      'Use submit_result with pass when the implementation is ready for verification. ' +
      'Report your checks and any limits. The coordinator verifies and integrates. ' +
      'Use blocked with hostActions when a prerequisite prevents completing your own work.'
    )
  }

  return (
    'Use submit_result when finished. If a host capability is required, return blocked ' +
    'with hostActions immediately. Do not retry unavailable operations in the sandbox.'
  )
}

export async function assignment(request: WorkerRequest) {
  const paths = Object.keys(request.baseline)
  const smallIndex = paths.length <= 100 && Buffer.byteLength(JSON.stringify(paths)) <= 4096

  return {
    assignment: request.task,
    ...(request.checkout && { checkout: request.checkout }),
    acceptedDesign: request.checkpoint,
    changedFiles: request.changedFiles ?? (await changedSinceBaseline(request)),
    ...(smallIndex ? { originalPaths: paths } : {}),
    checks: request.project.checks,
    execution: storedExecution(request.project.execution),
    capabilities: workerCapabilities(storedExecution(request.project.execution).mode),
    ...(request.documentsOnly ? { retainedFileTypes: ['.md', '.txt', '.rst'] } : {}),
    folderInstructions: await instructions(request.workspace, request.checkpoint.writePaths),
    output: submissionInstructions(request.role),
  }
}
