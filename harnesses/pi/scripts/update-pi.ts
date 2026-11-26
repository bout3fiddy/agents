import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pinFiles = ['package.json', 'package-lock.json'] as const
const backupName = '.pi-update-backup'

const piPrefix = '@earendil-works/pi-'
const corePackage = '@earendil-works/pi-coding-agent'

export const usage = [
  'Usage: pi-harness update [version] [--force]',
  '',
  'Updates both exact Pi pins in the canonical checkout, refreshes package-lock.json, and',
  'runs npm ci, typecheck and tests. Failure restores the previous files and installed tree.',
  'Save or stash existing edits to either pin file first. Review and publish the resulting',
  'changes separately; existing jobs keep their pinned commits.',
  '--force skips only the running-process check. From a deployment worktree, rerun',
  'npm run update:pi -- [version] in the primary checkout’s harnesses/pi directory.',
].join('\n')

export type UpdateDeps = {
  root: string
  verifyCheckout?: () => void
  verifyWritablePins?: () => void
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

  if (!names.includes(corePackage) || !names.includes(`${piPrefix}tui`)) {
    throw new Error(`${join(root, 'package.json')} must pin both Pi SDK and TUI dependencies.`)
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
  const ancestors = (start: number) => {
    const seen = new Set<number>()

    for (let pid: number | undefined = start; pid && !seen.has(pid); pid = parents.get(pid)) {
      seen.add(pid)
    }

    return seen
  }
  const lineage = ancestors(selfPid)

  // Descendants too: tsx starts an esbuild service child that runs from root's node_modules.
  return rows
    .filter((row) => !lineage.has(row.pid) && !ancestors(row.pid).has(selfPid))
    .filter((row) => row.command.includes(prefix))
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

  try {
    deps.verifyCheckout?.()
    return await withUpdateBackup(deps, args)
  } catch (error) {
    log((error as Error).message)
    return 1
  }
}

type Pins = { dependencies?: Record<string, string>; version?: string }

async function piVersions(root: string, packages: string[]) {
  const manifest = await readJsonFile<Pins>(join(root, pinFiles[0]))
  const lock = await readJsonFile<{ packages?: Record<string, Pins> }>(join(root, pinFiles[1]))
  return Promise.all(
    packages.map(async (name) => ({
      name,
      manifest: manifest?.dependencies?.[name],
      lockPin: lock?.packages?.['']?.dependencies?.[name],
      locked: lock?.packages?.[`node_modules/${name}`]?.version,
      installed: await installedVersion(root, name),
    })),
  )
}

async function withUpdateBackup(deps: UpdateDeps, args: ReturnType<typeof parseArgs>) {
  const backup = join(deps.root, backupName)

  try {
    await mkdir(backup, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Update in progress or interrupted. Inspect ${backup} before retrying.`, {
        cause: error,
      })
    }

    throw error
  }

  // Once the original tree moves, keep all backups until validation or rollback completes.
  let keepBackup = false

  try {
    const plan = await planUpdate(deps, args)

    if (typeof plan === 'number') {
      return plan
    }

    const { root, log } = deps
    const { packages, target } = plan
    log(`Updating ${root} to Pi ${target}. Recovery files: ${backup}`)
    await saveOriginal(root, backup)
    keepBackup = true

    try {
      deps.install(packages.map((name) => `${name}@${target}`))

      if (!(await piVersions(root, packages)).every((pin) => matchesTarget(pin, target))) {
        throw new Error(`Clean install does not match exact Pi ${target} pins.`)
      }

      if (!deps.check()) {
        throw new Error(`Harness checks failed on Pi ${target}.`)
      }
    } catch (error) {
      log(`${(error as Error).message} Restoring previous files and tree.`)
      await restoreOriginal(root, backup)
      keepBackup = false
      log('Restored previous pins and installed tree.')
      return 1
    }

    keepBackup = false
    log(`The harness now runs Pi ${target}. Review the pin changes and restart open sessions.`)
    return 0
  } finally {
    if (!keepBackup) {
      await rm(backup, { recursive: true })
    }
  }
}

function matchesTarget(pin: Awaited<ReturnType<typeof piVersions>>[number], target: string) {
  return [pin.manifest, pin.lockPin, pin.locked, pin.installed].every((value) => value === target)
}

async function planUpdate(deps: UpdateDeps, args: ReturnType<typeof parseArgs>) {
  const { log, root } = deps
  const packages = await piPackages(root)
  const before = await piVersions(root, packages)
  const target = deps.resolveVersion(corePackage, args.spec)

  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(target)) {
    throw new Error(`Expected an exact published Pi version, got ${target}`)
  }

  if (before.every((pin) => matchesTarget(pin, target))) {
    log(`The harness already runs Pi ${target}.`)
    return 0
  }

  const first = before[0]!.installed

  if (!first || !before.every((pin) => matchesTarget(pin, first))) {
    log(`Preexisting Pi drift: ${JSON.stringify(before)}`)
  }

  // Replacing modules under a live worker can break its next lazy import mid-task.
  const busy = args.force ? [] : deps.harnessProcesses()

  if (busy.length) {
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

  deps.verifyWritablePins?.()
  return { packages, target }
}

async function saveOriginal(root: string, backup: string) {
  for (const file of pinFiles) {
    if (!(await lstat(join(root, file))).isFile()) {
      throw new Error(`Expected a regular ${file} in ${root}.`)
    }

    await copyFile(join(root, file), join(backup, file))
  }

  const modules = join(root, 'node_modules')

  if (!(await lstat(modules)).isDirectory()) {
    throw new Error(`Expected a local node_modules directory. Run npm ci in ${root} first.`)
  }

  await rename(modules, join(backup, 'node_modules'))
}

async function restoreOriginal(root: string, backup: string) {
  try {
    for (const file of pinFiles) {
      await copyFile(join(backup, file), join(root, file))
    }

    const modules = join(root, 'node_modules')
    await rm(modules, { recursive: true, force: true })
    await rename(join(backup, 'node_modules'), modules)
  } catch (error) {
    throw new Error(`Rollback failed; recover from ${backup}: ${(error as Error).message}`, {
      cause: error,
    })
  }
}

export function defaultDeps(root: string): UpdateDeps {
  const npm = (args: string[]) =>
    execFileSync('npm', ['--prefix', root, '--global=false', ...args], {
      cwd: root,
      stdio: 'inherit',
    })
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return {
    root,
    verifyCheckout: () => {
      const next = 'Run npm run update:pi in the canonical primary checkout’s harnesses/pi.'

      try {
        const top = git('rev-parse', '--show-toplevel')
        const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')

        if (resolve(root) !== join(top, 'harnesses/pi') || common !== join(top, '.git')) {
          throw new Error(`Not the primary harness checkout: ${root}`)
        }

        git('symbolic-ref', '--quiet', 'HEAD')
        git('ls-files', '--error-unmatch', '--', ...pinFiles)
      } catch (error) {
        throw new Error(`${(error as Error).message}. ${next}`, { cause: error })
      }
    },
    verifyWritablePins: () => {
      if (git('status', '--porcelain', '--', ...pinFiles)) {
        throw new Error('Save or stash your manifest and lockfile edits before updating Pi.')
      }
    },
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
      const pins = specs.map((spec) => {
        const at = spec.lastIndexOf('@')
        return `dependencies.${spec.slice(0, at)}=${spec.slice(at + 1)}`
      })
      const flags = ['--ignore-scripts', '--no-audit', '--no-fund']
      npm(['pkg', 'set', ...pins])
      npm(['install', '--package-lock-only', ...flags])
      npm(['ci', ...flags])
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
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
  process.exitCode = await updatePi(process.argv.slice(2), defaultDeps(root))
}
