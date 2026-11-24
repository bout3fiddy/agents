import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const limit = 256 * 1024
const reference = 'Follow [Tiger Style](TIGER_STYLE.md).'
const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK

async function projectRoot(cwd: string): Promise<string> {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 65536,
    }).replace(/\n$/, '')
  } catch (error) {
    if (!/^fatal: not a git repository/m.test(String((error as { stderr?: string }).stderr))) {
      throw error
    }

    return realpath(cwd)
  }
}

async function claim(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      await delay(20)
    }
  }

  throw new Error(`Tiger Style setup is locked: ${path}`)
}

async function existing(path: string): Promise<string | undefined> {
  const file = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }
  })

  if (!file) {
    return undefined
  }

  try {
    const stat = await file.stat()

    if (!stat.isFile() || stat.size > limit) {
      throw new Error(`Unsafe or oversized Tiger Style input: ${path}`)
    }

    const buffer = Buffer.alloc(stat.size)
    let offset = 0

    while (offset < stat.size) {
      const { bytesRead } = await file.read(buffer, offset, stat.size - offset, offset)

      if (!bytesRead) {
        throw new Error(`Input changed during Tiger Style setup: ${path}`)
      }

      offset += bytesRead
    }

    return buffer.toString('utf8')
  } finally {
    await file.close()
  }
}

async function append(path: string, content: string, create: boolean): Promise<void> {
  const mode = create ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND
  const file = await open(path, flags | constants.O_WRONLY | mode)

  try {
    const stat = await file.stat()

    if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(content) > limit) {
      throw new Error(`Unsafe Tiger Style destination: ${path}`)
    }

    await file.writeFile(content)
  } finally {
    await file.close()
  }
}

export async function furnishTigerStyle(cwd: string): Promise<string> {
  const root = await projectRoot(cwd)
  const lock = join(root, '.pi-tiger-style.lock')
  await claim(lock)

  try {
    const path = join(root, 'TIGER_STYLE.md')
    const guide = await existing(path)
    const licensePath = join(root, 'TIGER_STYLE_LICENSE')
    const license = await existing(licensePath)
    const bundle = new URL('../guidelines/', import.meta.url)
    const expected = await readFile(new URL('TIGER_STYLE_LICENSE', bundle), 'utf8')
    const agents = join(root, 'AGENTS.md')
    const rules = await existing(agents)

    if (guide !== undefined && !guide.includes('\n## Repository guidance\n')) {
      throw new Error(`Conflicting Tiger Style guide; reconcile manually: ${path}`)
    }

    if (license !== undefined && license !== expected) {
      throw new Error(`Conflicting Tiger Style license: ${licensePath}`)
    }

    if (license === undefined) {
      await append(licensePath, expected, true)
    }

    if (guide === undefined) {
      await append(path, await readFile(new URL('TIGER_STYLE.md', bundle), 'utf8'), true)
    }

    if (!rules?.includes('](TIGER_STYLE.md)')) {
      await append(agents, `${rules ? '\n\n' : ''}${reference}\n`, rules === undefined)
    }

    return [
      `Host: read ${path}. Workers consume the guide; do not delegate customization.`,
      'Before product implementation, inspect actual instructions, languages, architecture,',
      'manifests and executable checks. If pending, write repository-specific safety, resource,',
      'error and concurrency rules, commands and evidence. Only then mark Customized.',
      'Retain existing guidance and reconcile it when the repository materially changes.',
    ].join(' ')
  } finally {
    await rmdir(lock)
  }
}
