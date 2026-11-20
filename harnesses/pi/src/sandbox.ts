import { spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult } from './contracts.ts'

const outputLimit = 64_000
const workerTermination = new AbortController()
export const workerAbortSignal = workerTermination.signal

// The dispatcher first signals the whole worker group, including Claude's MCP bridge.
// Keep those processes alive briefly so their separately grouped commands can be stopped.
if (process.env.PI_HARNESS_WORKER === '1') {
  const stop = () => workerTermination.abort(new Error('Worker process terminated'))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

export async function sandboxProfile(workspace: string, scratch: string): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'This installation requires macOS sandbox-exec; no unsandboxed ' + 'fallback exists',
    )
  }

  await access('/usr/bin/sandbox-exec')
  const roots = await Promise.all([realpath(workspace), realpath(scratch)])
  const readable = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/lib',
    '/opt/homebrew/opt',
    '/Library/Apple',
    '/Library/Developer/CommandLineTools',
    '/dev',
    ...roots,
  ]
  const harness = await realpath(new URL('../', import.meta.url))

  for (const path of ['src', 'scripts', 'node_modules', 'roles', 'prompts', 'package.json']) {
    readable.push(join(harness, path))
  }

  const nodeModules = join(workspace, 'node_modules')

  try {
    readable.push(await realpath(nodeModules))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/"))',
    '(allow signal (target self))',
    ...readable.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    ...roots.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    '(allow file-read* (literal "/private/etc/localtime") (literal ' + '"/private/etc/hosts"))',
  ].join('\n')
}

export async function runSandboxed(
  workspace: string,
  argv: string[],
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal = signal ? AbortSignal.any([signal, workerAbortSignal]) : workerAbortSignal

  if (
    !argv.length ||
    argv.length > 100 ||
    argv.some((arg) => arg.length > 32000 || arg.includes('\0'))
  ) {
    throw new Error('Invalid command arguments')
  }

  if (timeoutMs < 1 || timeoutMs > 900_000) {
    throw new Error('Command timeout must be between 1 ms and 15 minutes')
  }

  signal?.throwIfAborted()
  const scratch = await mkdtemp(join(tmpdir(), 'pi-command-'))
  const profile = join(scratch, 'policy.sb')
  const started = Date.now()

  try {
    await writeFile(profile, await sandboxProfile(workspace, scratch))

    if (signal.aborted) {
      return {
        argv,
        exitCode: null,
        output: '',
        timedOut: false,
        aborted: true,
        truncated: false,
        durationMs: Date.now() - started,
      }
    }

    const result = await new Promise<CommandResult>((resolve, reject) => {
      const command = argv[0] === 'node' ? process.execPath : argv[0]!
      const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, command, ...argv.slice(1)], {
        cwd: workspace,
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: scratch,
          TMPDIR: scratch,
          LANG: 'en_US.UTF-8',
          CI: '1',
          npm_config_offline: 'true',
          NO_COLOR: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          UV_CACHE_DIR: join(scratch, 'uv-cache'),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let truncated = false
      let timedOut = false
      let aborted = false
      let settled = false
      let drainTimer: ReturnType<typeof setTimeout> | undefined

      const capture = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        truncated ||= output.length + text.length > outputLimit
        output = (output + text).slice(0, outputLimit)
      }

      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              reject(error)
            }
          }
        }
      }

      const cancel = () => {
        aborted = true
        kill()
        boundedDrain(null)
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
        boundedDrain(null)
      }, timeoutMs)
      const finish = (exitCode: number | null, undrained = false) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)
        clearTimeout(drainTimer)
        signal?.removeEventListener('abort', cancel)
        kill()

        if (undrained) {
          output =
            output.slice(0, outputLimit - 200) +
            '\nCommand streams remained open after termination; detached descendants unsupported.'
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
        }

        resolve({
          argv,
          exitCode: undrained ? null : exitCode,
          output,
          timedOut,
          aborted,
          truncated,
          durationMs: Date.now() - started,
        })
      }
      const boundedDrain = (exitCode: number | null) => {
        drainTimer ??= setTimeout(() => finish(exitCode, true), 250)
      }
      signal?.addEventListener('abort', cancel, { once: true })

      if (signal?.aborted) {
        cancel()
      }

      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      child.once('error', (error) => {
        settled = true
        clearTimeout(timer)
        clearTimeout(drainTimer)
        signal?.removeEventListener('abort', cancel)
        reject(error)
      })
      child.once('exit', (exitCode) => {
        kill()
        boundedDrain(exitCode)
      })
      child.once('close', (exitCode) => finish(exitCode))
    })
    return result
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
