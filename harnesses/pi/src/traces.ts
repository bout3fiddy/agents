import { appendFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

export function projectTraces(root: string, includeAudit = false): string {
  const directory = join(root, '.pi', 'traces')

  for (const path of [
    join(root, '.pi'),
    directory,
    join(directory, 'harness'),
    join(directory, 'sessions'),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })

    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error('Project trace directories must be real directories')
    }
  }

  const ignore = join(root, '.pi', '.gitignore')
  let contents = ''

  try {
    if (!lstatSync(ignore).isFile() || lstatSync(ignore).isSymbolicLink()) {
      throw new Error('Project trace ignore file must be a regular file')
    }

    contents = readFileSync(ignore, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const rules = contents.split(/\r?\n/)
  const required = includeAudit ? ['/traces/', '/audit/'] : ['/traces/']
  const missing = required.filter((rule) => !rules.includes(rule))

  if (missing.length) {
    appendFileSync(
      ignore,
      `${contents && !contents.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
    )
  }

  return directory
}

export async function shouldMirrorSession(source: string, destination: string): Promise<boolean> {
  const metadata = async (path: string) =>
    stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }

      return undefined
    })
  const original = await metadata(source)
  const target = await metadata(destination)
  return Boolean(
    original && (!target || original.dev !== target.dev || original.ino !== target.ino),
  )
}

export function registerTraces(pi: ExtensionAPI): void {
  let queue: Promise<void> = Promise.resolve()
  const mirror = async (_event: unknown, ctx: ExtensionContext) => {
    const directory = projectTraces(ctx.cwd)
    const manager = ctx.sessionManager
    const source = manager.getSessionFile()
    const header = manager.getHeader()

    if (!source || !header) {
      return
    }

    const destination = join(directory, 'sessions', basename(source))

    // The launcher already persists here. Never replace the live session writer's own file.
    if (!(await shouldMirrorSession(source, destination))) {
      return
    }

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join('\n')
    const write = queue.then(async () => {
      const temporary = `${destination}.${randomUUID()}.tmp`

      try {
        await writeFile(temporary, content + '\n', { mode: 0o600 })
        await rename(temporary, destination)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    queue = write.catch(() => {})
    await write
  }
  pi.on('session_start', mirror)
  pi.on('agent_end', mirror)
  pi.on('session_compact', mirror)
  pi.on('session_shutdown', mirror)
}
