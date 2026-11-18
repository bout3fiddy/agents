import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const excluded = new Set([
  '.git',
  'node_modules',
  '.runtime',
  '.harness',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  'test-results',
  'playwright-report',
  'reports',
  '.ssh',
  '.aws',
  '.azure',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.docker',
  'id_rsa',
  'id_ed25519',
])

function folded(path: string): string {
  return path
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
}

export function sensitive(path: string): boolean {
  const parts = path.split('/').map(folded)
  return (
    parts.some((part, index) => part === '.pi' && parts[index + 1] === 'traces') ||
    parts.some(
      (part) =>
        excluded.has(part) ||
        /^\.env(?:\.|$)/i.test(part) ||
        /^(?:auth|credentials|secrets)(?:\.|$)/i.test(part) ||
        /\.(?:pem|key|p12|pfx|jks|tfstate|tfvars)$/i.test(part),
    )
  )
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function readBoundedFile(path: string, limit = 2_000_000): Promise<Buffer> {
  const file = await open(path, 'r')

  try {
    const metadata = await file.stat()

    if (!metadata.isFile() || metadata.size > limit) {
      throw new Error('File is not regular or exceeds its read limit')
    }

    const buffer = Buffer.alloc(metadata.size + 1)
    let count = 0

    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count)

      if (!bytesRead) {
        break
      }

      count += bytesRead
    }

    if (count === buffer.length) {
      throw new Error('File grew during its bounded read')
    }

    return buffer.subarray(0, count)
  } finally {
    await file.close()
  }
}

export function relativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error('A repository-relative path is required')
  }

  const parts = value.split('/')

  if (parts.some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error('Path traversal or ambiguous path')
  }

  if (sensitive(value)) {
    throw new Error('Private, generated or dependency path is unavailable')
  }

  return value
}

export function matches(path: string, scope: string): boolean {
  if (scope === '**') {
    return true
  }

  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3)
    return path === prefix || path.startsWith(`${prefix}/`)
  }

  return path === scope
}

export function validateScope(scopes: string[]): void {
  for (const scope of scopes) {
    if (scope !== '**') {
      relativePath(scope.endsWith('/**') ? scope.slice(0, -3) : scope)
    }
  }
}

/** Validate newly assigned paths without reinterpreting existing reservations. */
export function validateWriteScope(scopes: string[], retained: string[] = []): void {
  validateScope(scopes)

  for (const scope of scopes) {
    const prefix = scope.endsWith('/**') ? scope.slice(0, -3) : scope

    if (scope !== '**' && prefix.includes('*') && !retained.includes(scope)) {
      throw new Error(
        `Unsupported wildcard in write scope "${scope}". List exact filenames or an ` +
          'authorized directory/**. Keep the original ownership boundary.',
      )
    }
  }
}

export function documentPath(path: string): boolean {
  return ['.md', '.txt', '.rst'].includes(extname(path).toLowerCase())
}

export function writable(path: string, scopes: string[], documentsOnly = false): boolean {
  relativePath(path)
  const normalized = folded(path)

  return (
    (!documentsOnly || documentPath(path)) &&
    normalized !== '.pi' &&
    !normalized.startsWith('.pi/') &&
    !normalized.endsWith('agents.override.md') &&
    scopes.some((scope) => matches(path, scope))
  )
}

export async function safePath(root: string, name: string): Promise<string> {
  relativePath(name)
  const canonicalRoot = await realpath(root)
  let cursor = canonicalRoot

  for (const part of name.split('/')) {
    cursor = join(cursor, part)

    try {
      const info = await lstat(cursor)

      if (info.isSymbolicLink()) {
        throw new Error('Symbolic links are unavailable to agent file tools')
      }

      if ((await realpath(cursor)).normalize('NFC') !== cursor.normalize('NFC')) {
        throw new Error('Filesystem spelling aliases are unavailable; use the actual file name')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  if (!cursor.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error('Path escapes repository')
  }

  return cursor
}

export async function inventory(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  let bytes = 0

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')

      if (sensitive(name) || entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const info = await lstat(path)

        if (info.size > 2_000_000 || bytes + info.size > 100_000_000 || files.size >= 10_000) {
          throw new Error(`Snapshot limit exceeded at ${name}; narrow the project workspace`)
        }

        const content = await readBoundedFile(path)
        bytes += content.length
        files.set(name, content)
      }
    }
  }

  let names: string[] | undefined

  try {
    const git = promisify(execFile)
    const listing = await git(
      'git',
      [
        '-C',
        root,
        '-c',
        'core.fsmonitor=false',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ],
      { maxBuffer: 4_000_000 },
    )
    names = [...new Set(listing.stdout.split('\0').filter(Boolean))]
  } catch (error) {
    if (!String(error).includes('not a git repository')) {
      throw error
    }
  }

  if (names) {
    for (const name of names) {
      if (sensitive(name)) {
        continue
      }

      let path: string

      try {
        path = await safePath(root, name)
      } catch {
        continue
      }

      try {
        const info = await lstat(path)

        if (!info.isFile()) {
          continue
        }

        if (info.size > 2_000_000 || bytes + info.size > 100_000_000 || files.size >= 10_000) {
          throw new Error(`Snapshot limit exceeded at ${name}`)
        }

        const content = await readBoundedFile(path)
        bytes += content.length
        files.set(name, content)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  } else {
    await visit(resolve(root))
  }

  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)))
}

export async function rejectIgnoredAdditions(
  root: string,
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
): Promise<void> {
  const added = [...after.keys()].filter((name) => !before.has(name))

  if (!added.length) {
    return
  }

  const command = promisify(execFile)(
    'git',
    ['-C', root, '-c', 'core.fsmonitor=false', 'check-ignore', '-z', '--stdin'],
    {
      maxBuffer: 4_000_000,
    },
  )
  command.child.stdin?.on('error', () => {})
  command.child.stdin?.end(added.join('\0') + '\0')
  let ignored: string

  try {
    ignored = (await command).stdout
  } catch (error) {
    if ((error as { code?: number }).code === 1 || String(error).includes('not a git repository')) {
      return
    }

    throw error
  }

  throw new Error(`New files are ignored by project policy: ${ignored.replaceAll('\0', ', ')}`)
}

export function fileHashes(files: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)]))
}

export function snapshotHash(files: Map<string, Buffer>): string {
  return digest(JSON.stringify(fileHashes(files)))
}

export async function copySnapshot(files: Map<string, Buffer>, destination: string): Promise<void> {
  for (const [name, content] of files) {
    const path = await safePath(destination, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}
