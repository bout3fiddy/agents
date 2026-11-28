import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { invariant } from './invariant.ts'
import { projectRoot } from './tiger-style.ts'
import { projectTraces } from './traces.ts'

const execute = promisify(execFile)
export class MissingBoardCLI extends Error {
  constructor() {
    super('Install tldraw-sync on PATH or set PI_WHITEBOARD_BIN, then run /start_whiteboard.')
  }
}

// The one protocol this launcher speaks. tldraw-sync names the same number in
// src/shared/whiteboard.ts; the launcher, the CLI and the running daemon must all agree.
export const boardProtocol = 4

/** Three parties hold a protocol number. A mismatch names each one, so the fix is not a guess. */
export interface BoardVersions {
  requested: number
  cli?: number
  daemon?: number | 'stopped'
}

function upgradeAdvice({ requested, cli, daemon }: BoardVersions) {
  if (cli !== undefined && cli < requested) {
    return 'Upgrade tldraw-sync'
  }

  if (cli !== undefined && cli > requested) {
    return 'Update pih with `pih update`'
  }

  if (typeof daemon === 'number' && daemon !== requested) {
    return 'The daemon predates its CLI. Run `tldraw-sync stop`, which saves the board'
  }

  return 'Bring pih, tldraw-sync and its daemon to the same protocol'
}

export class BoardUpgradeRequired extends Error {
  readonly versions: BoardVersions

  constructor(versions: BoardVersions = { requested: boardProtocol }) {
    const daemon = versions.daemon === 'stopped' ? 'is not running' : 'reports'
    super(
      `Whiteboard protocol mismatch: pih requests ${versions.requested}, ` +
        `the tldraw-sync CLI supports ${versions.cli ?? 'an unknown version'}, ` +
        `the daemon ${daemon}${typeof versions.daemon === 'number' ? ' ' + versions.daemon : ''}` +
        `${versions.daemon === undefined ? ' an unknown version' : ''}. ` +
        `${upgradeAdvice(versions)}, then run /start_whiteboard.`,
    )
    this.versions = versions
  }
}
export type BoardCommand =
  'link' | 'poll' | 'ack' | 'snapshot' | 'preview' | 'publish' | 'scene' | 'edit'
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

function protocolNumber(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 10000
    ? value
    : undefined
}

// The CLI names the one protocol it speaks only in this fixed sentence. Nothing else is read
// from a failure message.
function requiredByCLI(failure: unknown) {
  const match =
    object(failure) && typeof failure.message === 'string'
      ? /^Whiteboard protocol (\d{1,4}) is required\.$/.exec(failure.message)
      : null
  return match ? protocolNumber(Number(match[1])) : undefined
}

/**
 * A CLI failure with a fixed hint. `settled` says the board certainly did not apply a native
 * edit: a conflict (exit 5) or a named rejection (exit 1). Any other edit failure may have
 * committed, so only the identical file may be sent again.
 */
export class BoardCommandFailed extends Error {
  constructor(
    message: string,
    readonly settled: boolean,
  ) {
    super(message)
  }
}

// Native edit rejections the CLI reports with exit 1 before anything is written.
const editRejections = ['request_id_reused', 'invalid_records', 'invalid_request', 'not_native']

// Scene codes a model can act on. The CLI's own message may quote drawn content, so only the
// code chooses the hint.
const hints: Record<string, string> = {
  not_native: 'This board is not native.',
  request_id_reused: 'That request_id named a different edit. Omit it or use a new one.',
  invalid_records: 'The edit records do not match the scene. Fix the file against the scene.',
  invalid_request: 'The edit file does not match the native edit schema.',
  stage_closed: 'Reopen the Mac stage with /start_whiteboard.',
  revision_conflict: 'The agent print changed. Take a fresh snapshot.',
  sketch_changed: 'The sketch changed. Take a fresh snapshot.',
  session_mismatch: 'The scene names another board. Take a fresh snapshot.',
  invalid_scene: 'The scene is invalid. Check it against the snapshot schema.',
  scene_too_large: 'The scene file is over the size limit.',
  scene_unreadable: 'The scene file is not a readable regular file.',
  preview_not_ready: 'The Mac stage did not draw the draft in time. Preview again.',
  image_not_ready: 'The Mac stage did not render in time. Try again.',
  sketch_busy: 'The sketch kept changing. Try again.',
}

function genericHint(command: BoardCommand) {
  if (command === 'link' || command === 'poll' || command === 'scene') {
    return 'Check the daemon with `tldraw-sync status`.'
  }

  return 'Check the daemon, open Mac stage and current revision.'
}

function commandFailure(command: BoardCommand, failure: unknown, exit?: unknown) {
  const code = object(failure) && failure.status === 'failure' ? failure.code : undefined
  const named = typeof code === 'string' && Object.hasOwn(hints, code) ? hints[code] : undefined

  if (command !== 'edit') {
    return new BoardCommandFailed(
      `Whiteboard ${command} failed. ${named || genericHint(command)}`,
      true,
    )
  }

  if (code !== undefined && exit === 5) {
    return new BoardCommandFailed(
      'Whiteboard edit conflicts with the board. Read the scene again and write a new edit ' +
        'on it; never resend this one.',
      true,
    )
  }

  if (exit === 1 && typeof code === 'string' && editRejections.includes(code)) {
    invariant(named !== undefined, 'Every edit rejection has a fixed hint')
    return new BoardCommandFailed(`Whiteboard edit rejected. ${named}`, true)
  }

  return new BoardCommandFailed(
    'Whiteboard edit outcome is unknown. Resend the identical file unchanged, or read the ' +
      'scene before writing another edit.',
    false,
  )
}

// Replies that name artifacts must never carry binding credentials.
const guardedReplies: BoardCommand[] = ['snapshot', 'scene', 'edit']

// Never attach stdout, stderr, argv or the underlying execFile error to a model-visible error.
export async function openBoardEndpoint(
  cwd: string,
  owner: string,
  requested = boardProtocol,
): Promise<BoardEndpoint> {
  const root = await realpath(await projectRoot(cwd))
  const [bin, ...prefix] = await launch(root, cwd)
  const binding = await bindingPath(root, owner)

  // `status` needs no binding and changes nothing. It is asked only after a mismatch.
  async function daemonProtocol(signal: AbortSignal): Promise<BoardVersions['daemon']> {
    const options = { cwd, signal, timeout: 3000, maxBuffer: 65536, encoding: 'utf8' as const }
    let reply: unknown

    try {
      reply = JSON.parse((await execute(bin, [...prefix, 'status', '--json'], options)).stdout)
    } catch (error) {
      signal.throwIfAborted()

      try {
        reply = JSON.parse(object(error) ? String(error.stdout) : '')
      } catch {
        return undefined
      }
    }

    if (object(reply) && reply.status === 'failure' && reply.code === 'not_running') {
      return 'stopped'
    }

    return object(reply) && reply.status === 'success' ? protocolNumber(reply.protocol) : undefined
  }

  async function mismatch(cli: number | undefined, signal: AbortSignal) {
    return new BoardUpgradeRequired({ requested, cli, daemon: await daemonProtocol(signal) })
  }

  return {
    binding,
    async run(command, args, signal) {
      await checkBinding(binding, command === 'link')
      const link = command === 'link'
      const argv = link ? ['--owner', owner, '--out', binding] : ['--binding', binding]

      if (link || command === 'poll') {
        argv.push('--protocol', String(requested))
      }

      // A preview waits for the Mac stage to draw the draft.
      const options = {
        cwd,
        signal,
        timeout: command === 'poll' ? 1500 : command === 'preview' ? 40000 : 15000,
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
        response = JSON.parse(stdout, guardedReplies.includes(command) ? publicField : undefined)
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

        if (object(response) && response.code === 'upgrade_required') {
          throw await mismatch(requiredByCLI(response), signal)
        }

        throw commandFailure(command, response, object(error) ? error.code : undefined)
      }

      if (!object(response) || response.status !== 'success') {
        throw commandFailure(command, response)
      }

      if ((link || command === 'poll') && response.protocol !== requested) {
        throw await mismatch(protocolNumber(response.protocol), signal)
      }

      if (link) {
        await checkBinding(binding, false)
      }

      return response
    },
  }
}
