import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { digest, projectBriefPath } from './paths.ts'
import { MemoryStore, type MemoryFact, type PendingLine } from './memory-store.ts'

export { projectBriefPath as briefName }
const maxBrief = 64 * 1024

function directory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })

  if (!lstatSync(path).isDirectory()) {
    throw new Error('Project memory requires a real directory at ' + path)
  }
}

export function repositoryStore(repo: { home: string; identity: string }) {
  const parent = join(repo.home, '.pi')
  const folder = join(parent, 'local-memory')
  directory(parent)
  directory(folder)
  const tracked = execFileSync(
    'git',
    ['-C', repo.home, '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--', '.pi/local-memory'],
    { timeout: 3000 },
  )

  if (tracked.length) {
    throw new Error('Private .pi/local-memory files are tracked. Remove them from the index.')
  }

  const ignore = join(folder, '.gitignore')

  try {
    writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  if (!lstatSync(ignore).isFile() || readFileSync(ignore, 'utf8') !== '*\n') {
    throw new Error('Private project memory requires .pi/local-memory/.gitignore to contain *')
  }

  const file = join(folder, 'memory.sqlite')

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = lstatSync(file + suffix, { throwIfNoEntry: false })

    if (info && (!info.isFile() || info.nlink !== 1)) {
      throw new Error('Unsafe SQLite file in .pi/local-memory')
    }
  }

  const agent =
    process.env.PI_HARNESS_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), '.pi', 'agent')
  return new MemoryStore(
    file,
    join(agent, 'project-memory', digest(repo.identity), 'memory.sqlite'),
  )
}

export function readBrief(home: string) {
  return readBriefBytes(home)?.toString('utf8') ?? ''
}

export function readBriefBytes(home: string) {
  if (!lstatSync(join(home, '.pi')).isDirectory()) {
    throw new Error('Unsafe .pi directory')
  }

  const path = join(home, projectBriefPath)
  let fd: number

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  try {
    const info = fstatSync(fd)

    if (!info.isFile() || info.nlink !== 1 || info.size > maxBrief) {
      throw new Error('Expected a regular project brief under 64 KiB')
    }

    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function entry(lines: string[], key: string) {
  const matches = lines.filter((line) => line.startsWith(`- **${key}** `))

  if (matches.length > 1) {
    throw new Error('Duplicate project brief key: ' + key)
  }

  return matches[0] ?? ''
}

export function portableLine(
  brief: string,
  fact: MemoryFact,
  share: boolean | undefined,
  fromWorker: boolean,
): PendingLine | undefined {
  const previous = entry(brief.split('\n'), fact.key)

  if (fromWorker || (!previous && (!share || fact.kind === 'tentative'))) {
    return undefined
  }

  // Demotion removes the old committed statement. Raw evidence always stays private.
  const paths = fact.paths.filter((path) => !/[\r\n`]/.test(path)).map((path) => '`' + path + '`')
  const references = paths.length ? ' — ' + paths.join(', ') : ''
  const line =
    share === false || fact.kind === 'tentative'
      ? ''
      : `- **${fact.key}** (${fact.kind}) ${fact.text.replace(/\s+/g, ' ').trim()}` + references
  return { key: fact.key, previous, line }
}

// Called under the shared SQLite writer lock. A restart can safely replay a completed rename.
export function syncBrief(db: MemoryStore, home: string) {
  const conflicts: string[] = []
  db.publishPending((rows) => {
    const before = readBrief(home)
    const lines = before.split('\n')
    const applied: string[] = []
    let changed = false

    for (const row of rows) {
      const existing = entry(lines, row.key)

      if (existing !== row.line && existing !== row.previous) {
        conflicts.push(row.key)
        continue
      }

      if (existing !== row.line) {
        changed = true

        if (existing) {
          lines.splice(lines.indexOf(existing), 1, ...(row.line ? [row.line] : []))
        } else {
          if (!before && !applied.length) {
            lines.unshift('# Project state')
          }

          lines.push(row.line)
        }
      }

      applied.push(row.key)
    }

    if (changed) {
      const after = lines.join('\n').trimEnd() + '\n'

      if (Buffer.byteLength(after) > maxBrief) {
        throw new Error('Project brief exceeds 64 KiB. Condense the brief before publishing.')
      }

      const path = join(home, projectBriefPath)
      const folder = join(home, '.pi', 'local-memory')
      directory(folder)
      const temporary = join(folder, randomUUID() + '.tmp')

      try {
        writeFileSync(temporary, after, { flag: 'wx', mode: 0o600, flush: true })

        if (readBrief(home) !== before) {
          throw new Error('Project brief changed during publication. Retry after reconciliation.')
        }

        renameSync(temporary, path)
        const dir = openSync(join(home, '.pi'), 'r')

        try {
          fsyncSync(dir)
        } finally {
          closeSync(dir)
        }
      } finally {
        rmSync(temporary, { force: true })
      }
    }

    return applied
  })
  return conflicts
}
