import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath, sensitive } from './paths.ts'

const git = promisify(execFile)

export async function memoryRepository(cwd: string) {
  try {
    const { stdout } = await git(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { timeout: 3000 },
    )
    const [root, common] = stdout.trimEnd().split('\n')

    if (!root || !common) {
      return undefined
    }

    const directory = await realpath(common)
    const info = await stat(directory, { bigint: true })
    const trees = await git('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], {
      timeout: 3000,
    })
    const primary = trees.stdout
      .split('\0\0')
      .find((record) => !record.split('\0').includes('bare'))
    const home = primary?.split('\0')[0]?.slice('worktree '.length)

    if (!home) {
      return undefined
    }

    return {
      root: await realpath(root),
      home: await realpath(home),
      identity: directory + '\0' + info.dev + ':' + info.ino,
    }
  } catch {
    return undefined
  }
}

export async function worktrees(root: string) {
  const { stdout } = await git('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], {
    maxBuffer: 1024 * 1024,
    timeout: 3000,
  })
  return stdout
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((v) => v.slice(9))
}

export async function sourceExcerpt(root: string, path: string, limit = 1600) {
  const file = await open(
    await safePath(root, path),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  )

  try {
    if (!(await file.stat()).isFile()) {
      throw new Error('Expected a regular file')
    }

    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await file.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').replaceAll('\0', '')
  } finally {
    await file.close()
  }
}

// Inspect at most 80 names per directory and keep a few representative paths per category.
export async function discoverSources(root: string, request = '') {
  const paths: string[] = []
  const terms = new Set(request.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const relevance = (name: string) =>
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => terms.has(t)).length
  const groups = [
    ['.', /^(readme(?:\..*)?|design\.md|package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i],
    ['design', /\.md$/i],
    ['docs', /\.md$/i],
    ['design/implementation', /\.md$/i],
    ['src', /\.(ts|js|tsx|py|go|rs|zig)$/],
    ['tests', /\.(ts|js|py|go|rs|zig)$/],
    ['test', /\.(ts|js|py|go|rs|zig)$/],
    ['app', /\.(ts|js|tsx|py|go|rs|zig)$/],
    ['lib', /\.(ts|js|py|go|rs|zig)$/],
    ['.', /^(main|app|index)\.(ts|js|py|go|rs|zig)$/],
  ] as const

  for (const [dir, pattern] of groups) {
    const found: string[] = []
    const path = dir === '.' ? root : await safePath(root, dir).catch(() => undefined)

    if (!path) {
      continue
    }

    const listing = await opendir(path).catch(() => undefined)

    if (!listing) {
      continue
    }

    let inspected = 0

    for await (const file of listing) {
      if (file.isFile() && pattern.test(file.name) && !sensitive(file.name)) {
        found.push(file.name)
      }

      if (++inspected >= 80) {
        break
      }
    }

    found.sort(
      (a, b) =>
        relevance(b) - relevance(a) ||
        Number(/^(readme|design\.|main\.|index\.)/i.test(b)) -
          Number(/^(readme|design\.|main\.|index\.)/i.test(a)) ||
        a.localeCompare(b),
    )

    for (const name of found.slice(0, 3)) {
      paths.push(dir === '.' ? name : join(dir, name))
    }
  }

  return paths.slice(0, 18)
}
