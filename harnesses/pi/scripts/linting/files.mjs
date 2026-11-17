import { readdir, readFile, lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative } from 'node:path'

const ignored = new Set([
  '.git',
  'node_modules',
  '.venv',
  'dist',
  'build',
  'reports',
  'test-results',
  '.runtime',
  '__pycache__',
  '.state',
  '.harness',
])
const generated = new Set(['package-lock.json', 'bun.lock', 'uv.lock'])

export async function sourceFiles(root) {
  const files = []
  const ignoredPath = (name) =>
    /(?:^|\/)\.pi\/traces(?:\/|$)/i.test(name.normalize('NFKC')) ||
    name
      .split('/')
      .some((part) => ignored.has(part) || generated.has(part) || /^\.env(?:\.|$)/.test(part))

  async function add(path, name) {
    if (ignoredPath(name)) {
      return
    }

    const info = await lstat(path)

    if (!info.isFile() || info.isSymbolicLink()) {
      return
    }

    if (info.size > 2_000_000) {
      if (/\.(?:[cm]?[jt]sx?|py|sh|json|md|ya?ml|toml|zig|rs|go|css|html)$/.test(name)) {
        throw new Error(`Authored source exceeds the 2 MB lint limit: ${name}`)
      }

      return
    }

    const bytes = await readFile(path)

    if (bytes.includes(0)) {
      return
    }

    try {
      files.push({ name, path, source: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
    } catch {
      // Binary evidence has no source-formatting rules.
    }
  }

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ignored.has(entry.name) ||
        generated.has(entry.name) ||
        entry.isSymbolicLink() ||
        /^\.env(?:\.|$)/.test(entry.name)
      ) {
        continue
      }

      const path = join(directory, entry.name)

      if (ignoredPath(relative(root, path))) {
        continue
      }

      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        await add(path, relative(root, path))
      }
    }
  }

  let names

  try {
    const result = await promisify(execFile)(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { maxBuffer: 4_000_000 },
    )
    names = [...new Set(result.stdout.split('\0').filter(Boolean))]
  } catch (error) {
    if (!String(error).includes('not a git repository')) {
      throw error
    }
  }

  if (names) {
    for (const name of names) {
      try {
        await add(join(root, name), name)
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error
        }
      }
    }
  } else {
    await walk(root)
  }

  return files.sort((a, b) => a.name.localeCompare(b.name))
}
