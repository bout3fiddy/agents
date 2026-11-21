import { spawn } from 'node:child_process'
import { access, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CommandResult } from './contracts.ts'
import { temporaryDirectory } from './temp.ts'

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

export async function sandboxProfile(
  workspace: string,
  scratch: string,
  extraReadable: string[] = [],
): Promise<string> {
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

  const resolve = async (path: string) => {
    try {
      return await realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      return undefined
    }
  }

  // Linked dependencies are readable. A virtual environment also needs its interpreter prefix,
  // which uv keeps below the home directory; nothing else in home becomes readable.
  const python = await resolve(join(workspace, '.venv', 'bin', 'python'))

  for (const path of [
    await resolve(join(workspace, 'node_modules')),
    await resolve(join(workspace, '.venv')),
    python && dirname(dirname(python)),
    ...extraReadable,
  ]) {
    if (path) {
      readable.push(path)
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

type RunOptions = { readable?: string[] }

export async function runSandboxed(
  workspace: string,
  argv: string[],
  timeoutMs = 120_000,
  signal?: AbortSignal,
  options: RunOptions = {},
): Promise<CommandResult> {
  return runCommand(workspace, argv, timeoutMs, signal, { ...options, host: false })
}

/** Project checks marked runner=host need services the sandbox denies: database servers,
 * browsers, loopback listeners or Docker. They still run in a disposable copy with a minimal
 * environment, but with the user's normal filesystem, network and process permissions. */
export async function runOnHost(
  workspace: string,
  argv: string[],
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return runCommand(workspace, argv, timeoutMs, signal, { host: true })
}

function hostEnvironment(scratch: string): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'DOCKER_HOST', 'DOCKER_CONFIG']
  return {
    ...Object.fromEntries(
      inherited.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
    HOME: homedir(),
    TMPDIR: scratch,
    LANG: 'en_US.UTF-8',
    CI: '1',
    NO_COLOR: '1',
  }
}

async function runCommand(
  workspace: string,
  argv: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  options: RunOptions & { host: boolean },
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
  const scratch = await temporaryDirectory('c')
  const profile = join(scratch, 'policy.sb')
  const started = Date.now()

  try {
    if (!options.host) {
      await writeFile(profile, await sandboxProfile(workspace, scratch, options.readable))
    }

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
      const [program, args] = options.host
        ? [command, argv.slice(1)]
        : ['/usr/bin/sandbox-exec', ['-f', profile, command, ...argv.slice(1)]]
      const child = spawn(program, args, {
        cwd: workspace,
        env: options.host
          ? hostEnvironment(scratch)
          : {
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
      let cleanupError = ''
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
            const code = (error as NodeJS.ErrnoException).code

            if (code === 'ESRCH') {
              return
            }

            cleanupError = 'Could not signal command process group: ' + (code ?? 'unknown error')

            if (child.exitCode === null && child.signalCode === null) {
              try {
                process.kill(child.pid, 'SIGKILL')
              } catch (leaderError) {
                const cause = (leaderError as NodeJS.ErrnoException).code

                if (cause !== 'ESRCH') {
                  cleanupError += '; command process signal failed: ' + (cause ?? 'unknown error')
                }
              }
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

        if (cleanupError) {
          const limit = outputLimit - cleanupError.length - 1
          truncated ||= output.length > limit
          output = output.slice(0, limit) + '\n' + cleanupError
        }

        resolve({
          argv,
          exitCode: undrained || cleanupError ? null : exitCode,
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
