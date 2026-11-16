import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicJson, readJson } from './state.ts'
import { harnessRoot } from './project.ts'
import { rolePrompt } from './roles.ts'
import { assignment } from './worker-tools.ts'
import { inventory, snapshotHash } from './paths.ts'
import {
  validateResult,
  type CommandResult,
  type Role,
  type WorkerEvidence,
  type WorkerRequest,
  type WorkerResult,
} from './contracts.ts'

export function claudeArguments(role: Role, configuration: string, prompt: string): string[] {
  return [
    '--dangerously-skip-permissions',
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} }),
    '--tools',
    '',
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
    '--max-turns',
    String(role.maxTurns),
    '--output-format',
    'json',
    '-p',
  ]
}

export async function runClaudeWorker(request: WorkerRequest, role: Role): Promise<WorkerEvidence> {
  const scratch = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  const requestPath = `${request.outputPath}.request.json`
  const configPath = join(scratch, 'mcp.json')
  const promptPath = join(scratch, 'system.txt')
  await atomicJson(requestPath, request)
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
    let output = ''
    let diagnostics = ''
    const input = JSON.stringify(await assignment(request))
    const child = spawn(
      process.env.PI_HARNESS_CLAUDE_BIN ?? 'claude',
      claudeArguments(role, configPath, promptPath),
      {
        cwd: scratch,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000)
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
    await writeFile(`${request.outputPath}.claude.json`, output, { mode: 0o600 })
    const response = JSON.parse(output) as {
      is_error?: boolean
      result?: string
      num_turns?: number
      modelUsage?: Record<string, unknown>
    }

    if (exitCode !== 0 || response.is_error) {
      throw new Error(`Claude worker failed: ${response.result ?? diagnostics}`)
    }

    const evidence = await readJson<{ commands: CommandResult[]; result?: WorkerResult }>(
      `${request.outputPath}.tools.json`,
    )

    if (!evidence?.result) {
      throw new Error(`Claude did not submit a scoped result: ${response.result?.slice(0, 2000)}`)
    }

    return {
      role: request.role,
      snapshot: snapshotHash(await inventory(request.workspace)),
      result: validateResult(evidence.result),
      commands: evidence.commands,
      turns: response.num_turns ?? 0,
      model: `claude-cli/${Object.keys(response.modelUsage ?? {})[0] ?? role.model}`,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
