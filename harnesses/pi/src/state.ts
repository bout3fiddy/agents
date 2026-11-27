import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest } from './paths.ts'
import { projectTraces } from './traces.ts'

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, JSON.stringify(value, null, 2) + '\n')
}

export async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)

  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }

  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')

  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

/** Where a checkout keeps its private harness files: worker records, traces, consultations. */
export class StateStore {
  readonly directory: string

  constructor(
    readonly projectRoot: string,
    stateRoot?: string,
    initializeTraces = true,
  ) {
    this.projectRoot = realpathSync(projectRoot)
    this.directory = stateRoot
      ? join(stateRoot, digest(this.projectRoot).slice(0, 24))
      : join(
          initializeTraces ? projectTraces(this.projectRoot) : join(this.projectRoot, '.pi/traces'),
          'harness',
        )
  }
}
