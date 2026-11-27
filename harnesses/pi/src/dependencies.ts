import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitCommand, GitCommandError } from './git-command.ts'
import { lockedDependencyDrift } from './worker-execution.ts'

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

async function lockfile(root: string, commit: string | undefined, signal?: AbortSignal) {
  if (!commit) {
    return readOptional(join(root, 'package-lock.json'))
  }

  try {
    return await gitCommand(root, ['show', `${commit}:package-lock.json`], signal)
  } catch (error) {

    // A commit without a lockfile has nothing to compare; other failures propagate.
    if (error instanceof GitCommandError) {
      return undefined
    }

    throw error
  }
}

/** Compare the direct dependencies a lockfile pins with the host node_modules that workers link.
 * Workers cannot install, so a mismatch here fails every check that imports the missing package.
 * Nested trees are compared with their own lockfiles when a command copy links them; see
 * linkLockedDependencies. */
export async function dependencyDrift(
  root: string,
  commit?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const text = await lockfile(root, commit, signal)

  if (!text) {
    return []
  }

  return lockedDependencyDrift(text, join(root, 'node_modules'))
}

/** Reject dispatch once, on the host, instead of letting every worker rediscover the gap. */
export async function requireDependencies(
  root: string,
  commit?: string,
  signal?: AbortSignal,
): Promise<void> {
  const problems = await dependencyDrift(root, commit, signal)

  if (!problems.length) {
    return
  }

  const listed = problems.slice(0, 8).join('; ')
  const more = problems.length > 8 ? `; ${problems.length - 8} more` : ''
  const source = commit ? ` at ${commit.slice(0, 12)}` : ''
  throw new Error(
    `Host node_modules does not match package-lock.json${source}: ${listed}${more}. ` +
      `Run npm ci in ${root} on the host with the user's authorization, then dispatch again.`,
  )
}
