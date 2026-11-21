import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitCommand } from './git-branches.ts'

type LockEntry = {
  version?: string
  link?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
type Lockfile = { packages?: Record<string, LockEntry> }

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
  } catch {
    return undefined
  }
}

/** Compare the direct dependencies a lockfile pins with the host node_modules that workers link.
 * Workers run offline, so a mismatch here fails every check that imports the missing package. */
export async function dependencyDrift(
  root: string,
  commit?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const text = await lockfile(root, commit, signal)

  if (!text) {
    return []
  }

  let lock: Lockfile

  try {
    lock = JSON.parse(text) as Lockfile
  } catch {
    return ['package-lock.json is not valid JSON']
  }

  const manifest = lock.packages?.['']
  const names = Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies }).sort()
  const problems: string[] = []

  for (const name of names) {
    const entry = lock.packages?.[`node_modules/${name}`]

    if (!entry?.version || entry.link) {
      continue
    }

    const installed = await readOptional(join(root, 'node_modules', name, 'package.json'))
    let version: string | undefined

    try {
      version = installed ? (JSON.parse(installed) as { version?: string }).version : undefined
    } catch {
      version = undefined
    }

    if (!version) {
      problems.push(`${name}@${entry.version} is missing`)
    } else if (version !== entry.version) {
      problems.push(`${name} is ${version}; the lockfile pins ${entry.version}`)
    }
  }

  return problems
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
