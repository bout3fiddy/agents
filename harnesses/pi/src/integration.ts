import { mkdir, readFile, rename, rm, open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson, readJson, type StateStore } from './state.ts'
import { digest, safePath, writable } from './paths.ts'

type Edit = { path: string; before: string | null; after: string | null }
type Journal = { status: 'pending' | 'complete'; edits: Edit[] }

export function changes(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (path) =>
        before.get(path)?.equals(after.get(path) ?? Buffer.alloc(0)) !== true ||
        before.has(path) !== after.has(path),
    )
    .sort()
}

async function bytes(root: string, name: string): Promise<string | null> {
  try {
    return (await readFile(await safePath(root, name))).toString('base64')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function recoverIntegration(store: StateStore): Promise<boolean> {
  const path = join(store.directory, 'integration.json')
  const journal = await readJson<Journal>(path)

  if (!journal || journal.status === 'complete') {
    return false
  }

  // Check every path before writing any, including edits from a partially completed application.
  for (const edit of journal.edits) {
    const current = await bytes(store.projectRoot, edit.path)

    if (current !== edit.before && current !== edit.after) {
      throw new Error(`Concurrent edit prevents integration recovery: ${edit.path}`)
    }
  }

  for (const edit of journal.edits) {
    const target = await safePath(store.projectRoot, edit.path)

    if (edit.after === null) {
      await rm(target, { force: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${randomUUID()}.tmp`
      let mode = 0o644

      try {
        mode = (await stat(target)).mode & 0o777
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      const file = await open(temporary, 'wx', mode)

      try {
        await file.writeFile(Buffer.from(edit.after, 'base64'))
        await file.sync()
      } finally {
        await file.close()
      }

      await rename(temporary, target)
    }

    const directory = await open(dirname(target), 'r')

    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  await atomicJson(path, { ...journal, status: 'complete' })
  return true
}

export async function integrate(
  store: StateStore,
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  scope: string[],
): Promise<void> {
  const edits: Edit[] = []

  for (const path of changes(before, after)) {
    if (!writable(path, scope)) {
      throw new Error(`Candidate changed forbidden path: ${path}`)
    }

    const previous = before.get(path)?.toString('base64') ?? null

    if ((await bytes(store.projectRoot, path)) !== previous) {
      throw new Error(`Concurrent edit prevents integration: ${path}`)
    }

    edits.push({ path, before: previous, after: after.get(path)?.toString('base64') ?? null })
  }

  await atomicJson(join(store.directory, 'integration.json'), {
    status: 'pending',
    edits,
    digest: digest(JSON.stringify(edits)),
  })
  await recoverIntegration(store)
}
