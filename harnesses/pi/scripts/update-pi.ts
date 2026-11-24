import { execFileSync, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The launcher and every worker import Pi from the harness's own node_modules, so one in-place
 * install updates both. `--no-save` keeps package.json and the lockfile unchanged: a newer Pi
 * needs no commit. The Pi-dependent harness checks gate the switch; a failure restores the
 * previous build. `npm ci` returns to the committed pin. */

const piPrefix = '@earendil-works/pi-'
const corePackage = '@earendil-works/pi-coding-agent'

export const usage = [
  'Usage: pi-harness update [version] [--force]',
  '',
  'Installs the latest Pi (or the given version or tag) into the harness without changing',
  'package.json or package-lock.json, runs the typecheck and tests against it and restores the',
  'previous Pi if they fail. --force skips the check for running harness processes.',
].join('\n')

export type UpdateDeps = {
  root: string
  resolveVersion: (name: string, spec: string) => string
  install: (specs: string[]) => void
  check: () => boolean
  harnessProcesses: () => string[]
  log: (line: string) => void
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

/** The direct Pi dependencies move together: pi-coding-agent pins the matching pi-tui, and a
 * mismatched direct pi-tui would give workers a second copy. */
export async function piPackages(root: string): Promise<string[]> {
  const manifest = await readJsonFile<{ dependencies?: Record<string, string> }>(
    join(root, 'package.json'),
  )
  const names = Object.keys(manifest?.dependencies ?? {}).filter((name) =>
    name.startsWith(piPrefix),
  )

  if (!names.includes(corePackage)) {
    throw new Error(`${join(root, 'package.json')} does not depend on ${corePackage}`)
  }

  return names.sort()
}

export async function installedVersion(root: string, name: string): Promise<string | undefined> {
  const manifest = await readJsonFile<{ version?: string }>(
    join(root, 'node_modules', name, 'package.json'),
  )
  return manifest?.version
}

/** Command lines from `ps -axo pid=,ppid=,command=` that run code from root, excluding this
 * process and its ancestors (the npm or tsx wrappers that started it). */
export function harnessCommands(psOutput: string, root: string, selfPid: number): string[] {
  const prefix = root.endsWith('/') ? root : `${root}/`
  const rows = psOutput.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]))
  const lineage = new Set<number>()

  for (let pid: number | undefined = selfPid; pid && !lineage.has(pid); pid = parents.get(pid)) {
    lineage.add(pid)
  }

  return rows
    .filter((row) => !lineage.has(row.pid) && row.command.includes(prefix))
    .map((row) => `${row.pid} ${row.command}`)
}

function parseArgs(argv: string[]) {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  const unknown = flags.filter((flag) => !['--force', '--help', '-h'].includes(flag))

  if (unknown.length || positional.length > 1) {
    throw new Error(`Unexpected arguments: ${[...unknown, ...positional.slice(1)].join(' ')}`)
  }

  return {
    spec: positional[0] ?? 'latest',
    force: flags.includes('--force'),
    help: flags.includes('--help') || flags.includes('-h'),
  }
}

export async function updatePi(argv: string[], deps: UpdateDeps): Promise<number> {
  const { log } = deps
  let args: ReturnType<typeof parseArgs>

  try {
    args = parseArgs(argv)
  } catch (error) {
    log(`${(error as Error).message}\n\n${usage}`)
    return 2
  }

  if (args.help) {
    log(usage)
    return 0
  }

  const packages = await piPackages(deps.root)
  const before = new Map<string, string>()

  for (const name of packages) {
    const version = await installedVersion(deps.root, name)

    if (!version) {
      log(`${name} is not installed in ${deps.root}. Run npm ci there first.`)
      return 1
    }

    before.set(name, version)
  }

  const target = deps.resolveVersion(corePackage, args.spec)
  const current = before.get(corePackage)!

  if (packages.every((name) => before.get(name) === target)) {
    log(`The harness already runs Pi ${target}.`)
    return 0
  }

  // Replacing modules under a live worker can break its next lazy import mid-task.
  const busy = deps.harnessProcesses()

  if (busy.length && !args.force) {
    log(
      [
        `Pi is in use by ${busy.length} harness process(es):`,
        ...busy.map((line) => `  ${line.slice(0, 160)}`),
        'Close open sessions and let background tasks finish, then rerun.',
        'Pass --force to skip this check.',
      ].join('\n'),
    )
    return 1
  }

  const restore = () => {
    deps.install(packages.map((name) => `${name}@${before.get(name)}`))
  }

  log(`Updating the harness from Pi ${current} to ${target}.`)

  try {
    deps.install(packages.map((name) => `${name}@${target}`))

    if (deps.check()) {
      log(`The harness now runs Pi ${target}. Restart open sessions to load it.`)
      return 0
    }

    log(`Harness checks failed on Pi ${target}; restoring Pi ${current}.`)
  } catch (error) {
    log(`Installing Pi ${target} failed: ${(error as Error).message}; restoring Pi ${current}.`)
  }

  try {
    restore()
    log(`Restored Pi ${current}.`)
  } catch (error) {
    log(`Restoring Pi ${current} failed: ${(error as Error).message}. Run npm ci in ${deps.root}.`)
  }

  return 1
}

export function defaultDeps(root: string): UpdateDeps {
  const npm = (args: string[]) => execFileSync('npm', args, { cwd: root, stdio: 'inherit' })
  return {
    root,
    resolveVersion: (name, spec) => {
      const output = execFileSync('npm', ['view', `${name}@${spec}`, 'version', '--json'], {
        cwd: root,
        encoding: 'utf8',
      })
      const parsed = output.trim() ? (JSON.parse(output) as string | string[]) : []
      const versions = Array.isArray(parsed) ? parsed : [parsed]

      if (!versions.length) {
        throw new Error(`No published ${name} matches ${spec}`)
      }

      return versions.at(-1)!
    },
    install: (specs) => {
      npm(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...specs])
    },

    // Formatting and lint do not depend on Pi; typecheck and tests exercise its API and runtime.
    check: () =>
      ['typecheck', 'test'].every(
        (script) => spawnSync('npm', ['run', script], { cwd: root, stdio: 'inherit' }).status === 0,
      ),
    harnessProcesses: () =>
      harnessCommands(
        execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }),
        root,
        process.pid,
      ),
    log: (line) => console.log(line),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  process.exitCode = await updatePi(process.argv.slice(2), defaultDeps(root))
}
