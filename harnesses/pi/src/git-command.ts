import { spawn } from 'node:child_process'

const outputLimit = 2_000_000

export class GitCommandError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message)
  }
}

/** Host-only Git operations. Workers never receive this command runner. */
async function executeGit(
  root: string,
  args: string[],
  signal?: AbortSignal,
  overrides: string[] = [],
): Promise<string> {
  signal?.throwIfAborted()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  const options = [
    '-C',
    root,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'tag.gpgSign=false',
    '-c',
    'merge.autoStash=false',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'merge.default=text',
    ...overrides.flatMap((value) => ['-c', value]),
  ]
  return new Promise((accept, reject) => {
    const child = spawn('git', [...options, ...args], {
      cwd: root,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let escalation: NodeJS.Timeout | undefined
    const stop = (error: Error) => {
      failure ??= error

      if (escalation || !child.pid) {
        return
      }

      const kill = (kind: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, kind)
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') {
            failure = killError as Error
          }
        }
      }
      kill('SIGTERM')
      escalation = setTimeout(() => kill('SIGKILL'), 1000)
    }
    const abort = () => stop(new Error('Git operation cancelled'))
    const timer = setTimeout(() => stop(new Error('Git operation exceeded 120 seconds')), 120_000)
    signal?.addEventListener('abort', abort, { once: true })

    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      stream.on('data', (chunk: Buffer) => {
        if (stdout.length + stderr.length + chunk.length > outputLimit) {
          stop(new Error('Git operation exceeded the output limit'))
          return
        }

        if (name === 'stdout') {
          stdout += chunk.toString()
        } else {
          stderr += chunk.toString()
        }
      })
    }

    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(escalation)
      signal?.removeEventListener('abort', abort)

      if (failure) {
        reject(failure)
      } else if (code !== 0) {
        reject(new GitCommandError(code, `Git ${args[0]} failed: ${stderr.slice(-8000)}`))
      } else {
        accept(stdout.trimEnd())
      }
    })

    if (signal?.aborted) {
      abort()
    }
  })
}

export async function gitCommand(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const configured = await executeGit(
    root,
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^(filter|merge)\\..*\\.(clean|smudge|process|driver|required)$',
    ],
    signal,
  ).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.code === 1) {
      return ''
    }

    throw error
  })
  const groups = new Set(
    configured
      .split('\0')
      .filter(Boolean)
      .map((key) => key.slice(0, key.lastIndexOf('.'))),
  )
  const overrides = [...groups].flatMap((key) =>
    key.startsWith('filter.')
      ? [`${key}.clean=`, `${key}.smudge=`, `${key}.process=`, `${key}.required=false`]
      : [`${key}.driver=false`],
  )

  return executeGit(root, args, signal, overrides)
}
