import { loadProject } from './project.ts'
import { gitCommand } from './git-branches.ts'

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
