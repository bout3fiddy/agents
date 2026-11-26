import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { projectRoot } from './tiger-style.ts'
import { projectTraces } from './traces.ts'

const execute = promisify(execFile)
export class MissingBoardCLI extends Error {
  constructor() {
    super('Install tldraw-sync on PATH or set PI_WHITEBOARD_BIN, then run /start_whiteboard.')
  }
}
export class BoardUpgradeRequired extends Error {
  constructor() {
    super(
      'Upgrade tldraw-sync to protocol 2, safely restart its daemon, then run /start_whiteboard.',
    )
  }
}
export type BoardCommand = 'link' | 'poll' | 'ack' | 'snapshot' | 'publish'
export type BoardReply = Record<string, unknown>
export interface BoardEndpoint {
  binding: string
  run: (command: BoardCommand, args: string[], signal: AbortSignal) => Promise<BoardReply>
}

export function object(value: unknown): value is BoardReply {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function executable(name: string, cwd: string) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  const candidates = name.includes('/') ? [resolve(cwd, name)] : dirs.map((dir) => join(dir, name))

  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)

      if ((await stat(path)).isFile()) {
        return path
      }
    } catch {
      // Not an executable candidate; continue the finite PATH search.
    }
  }

  return undefined
}

async function launch(root: string, cwd: string): Promise<[string, ...string[]]> {
  const override = process.env.PI_WHITEBOARD_BIN
  const bin = await executable(override || 'tldraw-sync', cwd)

  if (bin) {
    return [bin]
  }

  if (!override) {
    const main = join(dirname(root), 'tldraw-sync/src/cli/main.ts')
    const bun = await executable('bun', cwd)

    if (bun && (await stat(main).catch(() => undefined))?.isFile()) {
      return [bun, main]
    }
  }

  throw new MissingBoardCLI()
}

async function bindingPath(root: string, owner: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) {
    throw new Error('Invalid whiteboard session owner')
  }

  const directory = join(projectTraces(root), 'harness/whiteboards')
  await mkdir(directory, { mode: 0o700, recursive: true })

  if (!(await lstat(directory)).isDirectory()) {
    throw new Error('Unsafe whiteboard directory')
  }

  return join(directory, owner + '.json')
}

async function checkBinding(path: string, allowMissing: boolean) {
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new Error('Unsafe whiteboard binding directory')
  }

  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (!allowMissing || error.code !== 'ENOENT') {
      throw new Error('Whiteboard binding unavailable')
    }
  })

  if (info && (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)) {
    throw new Error('Unsafe whiteboard binding; expected a private regular file (0600)')
  }
}

// The snapshot schema is extensible, but must never expose binding credentials.
function publicField(key: string, value: unknown) {
  if (/token|credential|password|secret|authorization|binding_file/i.test(key)) {
    throw new Error('Unsafe whiteboard snapshot')
  }

  return value
}

function commandFailure(command: BoardCommand, failure: unknown) {
  let hint =
    command === 'link' || command === 'poll'
      ? 'Check the daemon and upgrade the CLI and daemon if they lack protocol 2.'
      : 'Check the daemon, open Mac stage and current revision.'

  if (object(failure) && failure.status === 'failure') {
    if (failure.code === 'upgrade_required') {
      return new BoardUpgradeRequired()
    }

    if (failure.code === 'stage_closed') {
      hint = 'Reopen the Mac stage with /start_whiteboard.'
    } else if (failure.code === 'revision_conflict' || failure.code === 'stale_snapshot') {
      hint = 'Take a fresh snapshot before publishing.'
    }
  }

  return new Error(`Whiteboard ${command} failed. ${hint}`)
}

// Never attach stdout, stderr, argv or the underlying execFile error to a model-visible error.
export async function openBoardEndpoint(cwd: string, owner: string): Promise<BoardEndpoint> {
  const root = await realpath(await projectRoot(cwd))
  const [bin, ...prefix] = await launch(root, cwd)
  const binding = await bindingPath(root, owner)
  return {
    binding,
    async run(command, args, signal) {
      await checkBinding(binding, command === 'link')
      const link = command === 'link'
      const argv = link ? ['--owner', owner, '--out', binding] : ['--binding', binding]

      if (link || command === 'poll') {
        argv.push('--protocol', '2')
      }

      const options = {
        cwd,
        signal,
        timeout: command === 'poll' ? 1500 : 15000,
        maxBuffer: (command === 'poll' ? 2 : 1) * 1024 * 1024,
        killSignal: 'SIGKILL' as const,
        encoding: 'utf8' as const,
      }
      let response: unknown

      try {
        const { stdout } = await execute(
          bin,
          [...prefix, 'whiteboard-' + command, ...argv, ...args, '--json'],
          options,
        )
        response = JSON.parse(stdout, command === 'snapshot' ? publicField : undefined)
      } catch (error) {
        signal.throwIfAborted()

        if (object(error) && error.code === 'ENOENT') {
          throw new MissingBoardCLI()
        }

        if (object(error) && typeof error.stdout === 'string') {
          try {
            response = JSON.parse(error.stdout)
          } catch {
            // Never expose malformed stdout (it may contain private credentials).
          }
        }

        throw commandFailure(command, response)
      }

      if (!object(response) || response.status !== 'success') {
        throw commandFailure(command, response)
      }

      if ((link || command === 'poll') && response.protocol !== 2) {
        throw new BoardUpgradeRequired()
      }

      if (link) {
        await checkBinding(binding, false)
      }

      return response
    },
  }
}
