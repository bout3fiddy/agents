import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicJson, readJson } from './state.ts'
import { harnessRoot } from './project.ts'
import { rolePrompt } from './roles.ts'
import { assignment } from './worker-tools.ts'
import { inventory, snapshotHash } from './paths.ts'
import { progressReporter } from './progress.ts'
import { LiveWorker } from './worker-live.ts'
import { ClaudeLiveTrace } from './worker-live-claude.ts'
import {
  validateResult,
  ProviderQuotaError,
  type CommandResult,
  type Role,
  type WorkerEvidence,
  type WorkerRequest,
  type WorkerResult,
} from './contracts.ts'

export function claudeArguments(
  role: Role,
  configuration: string,
  prompt: string,
  stream = false,
): string[] {
  return [
    '--dangerously-skip-permissions',
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      enabledPlugins: {},
      maxEffortLevel: role.thinking,
    }),
    '--tools',
    role.tools.filter((name) => ['WebSearch', 'WebFetch'].includes(name)).join(','),
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    configuration,
    '--system-prompt-file',
    prompt,
    '--model',
    role.model,
    '--effort',
    role.thinking,
    '--output-format',
    stream ? 'stream-json' : 'json',
    ...(stream ? ['--verbose', '--include-partial-messages'] : []),
    '-p',
  ]
}

export function parseClaudeTrace(output: string) {
  type Event = {
    type?: string
    is_error?: boolean
    result?: string
    error?: string
    rate_limit_info?: { status?: string; resetsAt?: number }
    num_turns?: number
    modelUsage?: Record<string, unknown>
    message?: {
      content?: {
        type: string
        name?: string
        id?: string
        tool_use_id?: string
        is_error?: boolean
      }[]
    }
  }
  const events = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event)
  const content = events.flatMap((event) => event.message?.content ?? [])
  const completed = new Set(
    content
      .filter((part) => part.type === 'tool_result' && !part.is_error)
      .map((part) => part.tool_use_id),
  )
  const response = events.findLast((event) => event.type === 'result')
  const limit = events.findLast((event) => event.type === 'rate_limit_event')?.rate_limit_info
  const lastAssistant = events.findLast((event) => event.type === 'assistant')
  const reset = typeof limit?.resetsAt === 'number' ? limit.resetsAt * 1000 : 0
  return {
    response,
    retryAt:
      response?.is_error &&
      lastAssistant?.error === 'rate_limit' &&
      limit?.status === 'rejected' &&
      Number.isSafeInteger(reset) &&
      reset > 0 &&
      reset <= 8.64e15
        ? reset
        : undefined,
    toolsUsed: [
      ...new Set(
        content
          .filter((part) => part.type === 'tool_use' && part.name && completed.has(part.id))
          .map((part) => part.name!),
      ),
    ],
  }
}

export async function runClaudeWorker(request: WorkerRequest, role: Role): Promise<WorkerEvidence> {
  const progress = progressReporter(request.outputPath, request.role)
  await progress.update({ stage: 'model', message: 'Claude worker starting' })
  const scratch = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  const requestPath = `${request.outputPath}.request.json`
  const configPath = join(scratch, 'mcp.json')
  const promptPath = join(scratch, 'system.txt')
  const live = await LiveWorker.start(request.project.root, {
    role: request.role,
    model: `claude-cli/${role.model}`,
    thinking: role.thinking,
    task: request.task,
    scope: request.checkpoint.writePaths,
    writeLimits:
      request.role === 'performance'
        ? [...role.writes, ...request.project.instrumentationPaths]
        : role.writes,
    output: request.outputPath,
    workspace: request.workspace,
    backend: 'claude',
    parentId: request.parentWorkerId,
    reviewOf: request.reviewOf,
  })
  await atomicJson(requestPath, { ...request, liveWorkerId: live.info.id })
  await atomicJson(configPath, {
    mcpServers: {
      piworker: {
        command: process.execPath,
        args: [
          '--import',
          join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
          join(harnessRoot, 'src/claude-tools.ts'),
          requestPath,
        ],
      },
    },
  })
  await writeFile(promptPath, await rolePrompt(request.role))

  try {
    let diagnostics = ''
    const input = JSON.stringify(await assignment(request))
    const tracePath = `${request.outputPath}.claude.jsonl`
    await writeFile(tracePath, '', { mode: 0o600 })
    const child = spawn(
      process.env.PI_HARNESS_CLAUDE_BIN ?? 'claude',
      claudeArguments(role, configPath, promptPath, true),
      {
        cwd: scratch,
        env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: role.thinking },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let overflow = false
    let outputBytes = 0
    let traceError: unknown
    const liveTrace = new ClaudeLiveTrace(live)
    child.stdout.on('data', (chunk: Buffer) => {
      void progress
        .update({ stage: 'model', message: 'Claude activity received' }, true)
        .catch(() => {})
      outputBytes += chunk.length

      if (outputBytes > 16_000_000) {
        overflow = true
        child.kill('SIGKILL')
        return
      }

      if (traceError) {
        return
      }

      try {

        // Append raw bytes as they arrive, preserving UTF-8 boundaries and live crash evidence.
        appendFileSync(tracePath, chunk)
        liveTrace.push(chunk)
      } catch (error) {
        traceError = error
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8000)
    })
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const exitCode = await completion

    if (traceError) {
      throw traceError
    }

    if (overflow) {
      throw new Error('Claude trace exceeded the 16 MB output budget')
    }

    const output = await readFile(tracePath, 'utf8')
    const { response, retryAt } = parseClaudeTrace(output)

    if (exitCode !== 0 || !response || response.is_error) {
      const message = `Claude worker failed: ${response?.result ?? diagnostics}`

      if (retryAt) {
        throw new ProviderQuotaError(
          message +
            ' Report blocked if this review is required. ' +
            'Resume after availability returns or new host guidance confirms access.',
          retryAt,
        )
      }

      throw new Error(message)
    }

    const evidence = await readJson<{ commands: CommandResult[]; result?: WorkerResult }>(
      `${request.outputPath}.tools.json`,
    )

    if (!evidence?.result) {
      throw new Error(`Claude did not submit a scoped result: ${response.result?.slice(0, 2000)}`)
    }

    await progress.update({ stage: 'complete', message: evidence.result.summary })
    await live.finish(
      evidence.result.verdict === 'pass' ? 'complete' : 'needs_attention',
      evidence.result.summary,
    )
    return {
      role: request.role,
      liveWorkerId: live.info.id,
      snapshot: snapshotHash(await inventory(request.workspace)),
      result: validateResult(evidence.result),
      commands: evidence.commands,
      turns: response.num_turns ?? 0,
      model: `claude-cli/${Object.keys(response.modelUsage ?? {})[0] ?? role.model}`,
      thinking: role.thinking,
    }
  } catch (error) {
    await live.finish('failed', String(error))
    throw error
  } finally {
    await live.settle()
    await progress.settle()
    await rm(scratch, { recursive: true, force: true })
  }
}
