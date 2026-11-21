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

/** Check policy is host-owned and committed, so a fix on the checkout reaches retained and resumed
 * tasks instead of stalling them on the policy they were dispatched with. Use the checkout's HEAD
 * while it still descends from the task's base; otherwise keep the pinned base's policy. */
export async function currentPolicyCommit(
  root: string,
  base: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const head = await gitCommand(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
    await gitCommand(root, ['merge-base', '--is-ancestor', base, head], signal)
    return head
  } catch (error) {
    signal?.throwIfAborted()

    if (error instanceof Error && !(error instanceof GitCommandError)) {
      throw error
    }

    return base
  }
}
