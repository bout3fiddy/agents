import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fail } from './protocol.ts'
import { isId } from './surface.ts'

export interface Owner {
  sessionId: string
  taskId: string
  worktree: string
}

export interface Snapshot {
  id: string
  sha256: string
}

export function sameOwner(left: Owner, right: Owner) {
  return (
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.worktree === right.worktree
  )
}

function outsideCheckouts(root: string, worktree: string) {
  const workspace = lstatSync(worktree, { bigint: true })
  let path = root

  for (let depth = 0; depth < 128; depth++) {
    const dir = lstatSync(path, { bigint: true })

    if (dir.dev === workspace.dev && dir.ino === workspace.ino) {
      return false
    }

    if (existsSync(join(path, '.git'))) {
      return false
    }

    const parent = dirname(path)

    if (parent === path) {
      return true
    }

    path = parent
  }

  return false
}

export function privateRoot(path: string, owner: Owner) {
  if (!isId(owner.sessionId) || !isId(owner.taskId) || !isAbsolute(owner.worktree)) {
    fail('invalid')
  }

  try {
    if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) {
      fail('storage')
    }

    if (
      realpathSync(owner.worktree) !== owner.worktree ||
      !lstatSync(owner.worktree).isDirectory()
    ) {
      fail('storage')
    }

    const root = resolve(path)

    if (!outsideCheckouts(root, owner.worktree)) {
      fail('storage')
    }

    const stat = lstatSync(root)

    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      fail('storage')
    }

    return root
  } catch {

    // Missing, redirected or insufficiently private storage is not usable.
    return fail('storage')
  }
}

export class WriterLease {
  private readonly path: string
  private held = false

  constructor(root: string) {
    this.path = join(root, 'desktop-writer.lock')
  }

  acquire() {
    try {
      mkdirSync(this.path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        fail('busy')
      }

      fail('storage')
    }

    this.held = true
  }

  release() {
    if (!this.held) {
      return
    }

    try {
      rmdirSync(this.path)
    } catch {

      // Never steal a lease or silently declare its cleanup successful.
      fail('storage')
    }

    this.held = false
  }
}

export function snapshot(root: string, payload: unknown): Snapshot {
  const bytes = JSON.stringify(payload)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const id = randomUUID()
  const path = join(root, `${id}.snapshot`)
  let fd: number

  try {
    fd = openSync(path, 'wx', 0o400)
  } catch {
    return fail('storage')
  }

  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } catch {
    unlinkSync(path)
    fail('storage')
  } finally {
    closeSync(fd)
  }

  return { id, sha256 }
}
