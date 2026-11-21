import { loadProject } from './project.ts'
import { gitCommand, GitCommandError } from './git-branches.ts'

export async function loadPinnedProject(root: string, base: string, signal?: AbortSignal) {
  return loadProject(root, async <T>(path: string) => {
    const entry = await gitCommand(root, ['ls-tree', base, '--', path], signal)

    if (!entry) {
      return undefined
    }

    if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) {
      throw new Error(`Check configuration must be a committed regular file: ${path}`)
    }

    const raw = await gitCommand(root, ['show', `${base}:${path}`], signal)
    return JSON.parse(raw) as T
  })
}

/** Check policy is host-owned and committed, and workers cannot edit .pi/, so a fix on the checkout
 * reaches retained and resumed tasks instead of stalling them on the policy they were dispatched
 * with. Tasks are often pinned to unmerged commits, so use the checkout's HEAD whether or not it
 * descends from the task's base. Fall back to the base only when HEAD cannot be resolved. */
export async function currentPolicyCommit(
  root: string,
  base: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await gitCommand(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
  } catch (error) {
    signal?.throwIfAborted()

    if (!(error instanceof GitCommandError)) {
      throw error
    }

    return base
  }
}
