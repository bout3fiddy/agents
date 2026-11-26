import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import type { CommandResult } from './contracts.ts'
import { runOnHost, runSandboxed } from './sandbox.ts'

// Host-owned execution policy for worker-issued commands. This module imports only Node built-ins
// and the command runner, so its critical decisions can be tested without installed dependencies.
//
// trusted-local runs argv as a normal local command with the user's authority. It is a statement
// that the user trusts the checkout, not a containment boundary. The other two modes run through
// the command sandbox; required-isolation additionally refuses every route to host execution.

/** Ordered from least to most isolated. Combining decisions always keeps the later mode. */
export const executionModes = ['trusted-local', 'isolated', 'required-isolation'] as const
export type ExecutionMode = (typeof executionModes)[number]
export type ExecutionReason =
  'enrolled' | 'unknown-project' | 'project-policy' | 'task-policy' | 'host-policy'
export type ExecutionPolicy = { mode: ExecutionMode; reason: ExecutionReason }
export type TrustDecision = 'trusted-local' | 'required-isolation'
export type TrustRegistry = {
  version: 1
  projects: Record<string, { execution: TrustDecision; decidedAt: string }>
}

/** Where the host keeps its decisions. Tests replace both; production uses the defaults. */
export type ExecutionSources = { registryPath?: string; environment?: NodeJS.ProcessEnv }

const reasonModes: Record<ExecutionReason, ExecutionMode> = {
  enrolled: 'trusted-local',
  'unknown-project': 'isolated',
  'project-policy': 'required-isolation',
  'task-policy': 'required-isolation',
  'host-policy': 'required-isolation',
}
const registryProjectLimit = 256
const registryByteLimit = 262_144
const linkedTreeLimit = 64
const lockfileSuffix = '/package-lock.json'

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The registry lives in the private agent directory, outside every project and worker copy. */
export function trustRegistryPath(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDirectory = environment.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  return join(agentDirectory, 'harness-trust.json')
}

function validRegistry(value: unknown, path: string): TrustRegistry {
  const registry = value as Partial<TrustRegistry> | null
  const projects = registry?.projects
  const valid =
    typeof registry === 'object' &&
    registry !== null &&
    registry.version === 1 &&
    typeof projects === 'object' &&
    projects !== null &&
    !Array.isArray(projects) &&
    Object.keys(projects).length <= registryProjectLimit &&
    Object.entries(projects).every(
      ([root, entry]) =>
        isAbsolute(root) &&
        typeof entry === 'object' &&
        entry !== null &&
        (entry.execution === 'trusted-local' || entry.execution === 'required-isolation') &&
        typeof entry.decidedAt === 'string',
    )

  if (!valid) {
    throw new Error(`Trust registry is invalid; repair or remove ${path}`)
  }

  return { version: 1, projects: { ...projects } }
}

/** A missing registry holds no decisions. A damaged one stops dispatch instead of guessing. */
export async function readTrustRegistry(path: string): Promise<TrustRegistry> {
  let text: string

  try {
    const info = await lstat(path)

    if (!info.isFile() || info.size > registryByteLimit) {
      throw new Error(`Trust registry is not a regular file within 256 KiB: ${path}`)
    }

    text = await readFile(path, 'utf8')
  } catch (error) {
    if (missing(error)) {
      return { version: 1, projects: {} }
    }

    throw error
  }

  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {

    // The parser message can quote file contents; the path is enough to repair it.
    throw new Error(`Trust registry is not valid JSON; repair or remove ${path}`)
  }

  return validRegistry(value, path)
}

async function writeTrustRegistry(path: string, registry: TrustRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)

  try {
    await file.writeFile(JSON.stringify(registry, null, 2) + '\n')
    await file.sync()
    await file.close()
    await rename(temporary, path)
  } catch (error) {

    // Close is idempotent here: a failed write leaves the handle open.
    await file.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}

/** PI_HARNESS_ISOLATION=required on the host process isolates every project it dispatches. */
export function hostRequiresIsolation(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.PI_HARNESS_ISOLATION

  if (value === undefined || value === '') {
    return false
  }

  if (value !== 'required') {
    throw new Error('PI_HARNESS_ISOLATION accepts only "required"; unset it for project decisions')
  }

  return true
}

/** Host code stores `isolation: 'required'` on a task whose input is external or untrusted. */
export function taskRequiresIsolation(task: object): boolean {
  const value = Object.hasOwn(task, 'isolation')
    ? (task as { isolation?: unknown }).isolation
    : undefined

  if (value === undefined) {
    return false
  }

  if (value !== 'required') {
    throw new Error('Task isolation accepts only "required"')
  }

  return true
}

export type ExecutionInput = {

  /** Canonical project root, or undefined when the path does not resolve. */
  root: string | undefined
  registry: TrustRegistry
  hostIsolation: boolean
  taskIsolation: boolean
}

/** Any isolation demand wins. Trust needs an exact enrolled root and no demand at all. */
export function decideExecution(input: ExecutionInput): ExecutionPolicy {
  if (input.hostIsolation) {
    return { mode: 'required-isolation', reason: 'host-policy' }
  }

  if (input.taskIsolation) {
    return { mode: 'required-isolation', reason: 'task-policy' }
  }

  const entry =
    input.root !== undefined && Object.hasOwn(input.registry.projects, input.root)
      ? input.registry.projects[input.root]
      : undefined

  if (!entry) {
    return { mode: 'isolated', reason: 'unknown-project' }
  }

  return entry.execution === 'trusted-local'
    ? { mode: 'trusted-local', reason: 'enrolled' }
    : { mode: 'required-isolation', reason: 'project-policy' }
}

/** Keep the more isolated of two decisions; the first wins a tie. */
export function strictest(first: ExecutionPolicy, second: ExecutionPolicy): ExecutionPolicy {
  return executionModes.indexOf(second.mode) > executionModes.indexOf(first.mode) ? second : first
}

/** Read a decision frozen into a stored request. Requests written before this policy existed
 * carry none and stay isolated; a malformed one is rejected rather than interpreted. */
export function storedExecution(value: unknown): ExecutionPolicy {
  if (value === undefined) {
    return { mode: 'isolated', reason: 'unknown-project' }
  }

  const policy = value as Partial<ExecutionPolicy> | null
  const reason = policy?.reason

  if (
    typeof policy !== 'object' ||
    policy === null ||
    typeof reason !== 'string' ||
    !Object.hasOwn(reasonModes, reason) ||
    reasonModes[reason] !== policy.mode
  ) {
    throw new Error('Invalid stored execution policy; the host must dispatch this task again')
  }

  return { mode: policy.mode, reason }
}

function nestedLockfiles(names: Iterable<string>): string[] {
  const nested: string[] = []

  for (const name of names) {
    if (!name.endsWith(lockfileSuffix)) {
      continue
    }

    const directory = name.slice(0, -lockfileSuffix.length)

    if (isAbsolute(directory) || directory.split('/').some((part) => !part || part === '..')) {
      throw new Error(`Invariant violated: lockfile path leaves the snapshot: ${name}`)
    }

    nested.push(directory)
  }

  return nested
}

async function canonicalRoot(root: string): Promise<string | undefined> {
  try {
    return await realpath(root)
  } catch (error) {
    if (missing(error)) {
      return undefined
    }

    throw error
  }
}

/** Resolve the host's current decision for a project root. */
export async function resolveExecution(
  root: string,
  taskIsolation = false,
  sources: ExecutionSources = {},
): Promise<ExecutionPolicy> {
  const hostIsolation = hostRequiresIsolation(sources.environment)
  const path = sources.registryPath ?? trustRegistryPath(sources.environment)
  const registry = await readTrustRegistry(path)
  return decideExecution({
    root: await canonicalRoot(root),
    registry,
    hostIsolation,
    taskIsolation,
  })
}

/** The decision a command actually runs under: the stricter of the one frozen at dispatch and
 * the host's current one. A request claiming trust for an unenrolled root therefore stays
 * isolated, and revoking trust takes effect on the next command. */
export async function effectiveExecution(
  project: { root: string; execution?: ExecutionPolicy },
  sources: ExecutionSources = {},
): Promise<ExecutionPolicy> {
  const frozen = storedExecution(project.execution)
  return strictest(frozen, await resolveExecution(project.root, false, sources))
}

/** Narrow a resolved project decision by the host task's own requirement. */
export function taskExecution(
  execution: ExecutionPolicy | undefined,
  task: object,
): ExecutionPolicy {
  const resolved = storedExecution(execution)
  return taskRequiresIsolation(task)
    ? strictest(resolved, { mode: 'required-isolation', reason: 'task-policy' })
    : resolved
}

/** Record or clear the user's decision for one project. Host only: run from cli.ts. Concurrent
 * recordings are not serialized; the last atomic replacement wins. */
export async function recordTrustDecision(
  root: string,
  decision: TrustDecision | 'unknown',
  sources: ExecutionSources = {},
  now = new Date(),
): Promise<ExecutionPolicy> {
  if (!['trusted-local', 'required-isolation', 'unknown'].includes(decision)) {
    throw new Error('Decision must be trusted-local, required-isolation or unknown')
  }

  const project = await realpath(root)

  if (!(await lstat(project)).isDirectory()) {
    throw new Error('A trust decision applies to a project directory')
  }

  const path = sources.registryPath ?? trustRegistryPath(sources.environment)
  const registry = await readTrustRegistry(path)
  const projects = Object.fromEntries(
    Object.entries(registry.projects).filter(([name]) => name !== project),
  )

  if (decision !== 'unknown') {
    projects[project] = { execution: decision, decidedAt: now.toISOString() }
  }

  if (Object.keys(projects).length > registryProjectLimit) {
    throw new Error(`Trust registry holds at most ${registryProjectLimit} projects`)
  }

  await writeTrustRegistry(path, { version: 1, projects })
  return resolveExecution(project, false, sources)
}

export type WorkerCommand = {
  workspace: string
  argv: string[]
  timeoutMs?: number
  signal?: AbortSignal

  /** Extra paths the sandbox may read. Trusted-local commands read as the user does. */
  readable?: string[]
}

/** The single route from a worker tool to a process. Only trusted-local leaves the sandbox, and
 * a sandbox that cannot start returns its failure: nothing here retries on the host. */
export async function runWorkerCommand(
  execution: ExecutionPolicy,
  command: WorkerCommand,
): Promise<CommandResult> {
  if (reasonModes[execution.reason] !== execution.mode) {
    throw new Error('Invariant violated: execution mode and reason disagree')
  }

  const { workspace, argv, timeoutMs, signal } = command

  if (execution.mode === 'trusted-local') {
    return runOnHost(workspace, argv, timeoutMs, signal)
  }

  return runSandboxed(workspace, argv, timeoutMs, signal, { readable: command.readable })
}

/** sandbox-exec could not apply its profile, as happens when it is nested. */
export function isolationUnavailable(result: CommandResult): boolean {
  return result.exitCode === 71 && result.output.startsWith('sandbox-exec: sandbox_apply')
}

/** Where a project check runs. A project adapter's runner=host is a repository file: it cannot
 * lift isolation the host requires, so such a check is refused instead of downgraded. */
export function checkRunner(
  execution: ExecutionPolicy,
  declared: 'sandbox' | 'host' | undefined,
): 'sandbox' | 'host' | 'refused' {
  if (execution.mode === 'trusted-local') {
    return 'host'
  }

  if (declared !== 'host') {
    return 'sandbox'
  }

  return execution.mode === 'isolated' ? 'host' : 'refused'
}

type LockEntry = {
  version?: string
  link?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
type Lockfile = { packages?: Record<string, LockEntry> }

async function installedVersion(modules: string, name: string): Promise<string | undefined> {
  try {
    const manifest = await readFile(join(modules, name, 'package.json'), 'utf8')
    return (JSON.parse(manifest) as { version?: string }).version
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) {
      return undefined
    }

    throw error
  }
}

/** Compare the direct dependencies a lockfile pins with one installed node_modules tree. */
export async function lockedDependencyDrift(lockText: string, modules: string): Promise<string[]> {
  let lock: Lockfile

  try {
    lock = JSON.parse(lockText) as Lockfile
  } catch {

    // Only validity matters; the parser message adds nothing a reader can act on.
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

    const version = await installedVersion(modules, name)

    if (!version) {
      problems.push(`${name}@${entry.version} is missing`)
    } else if (version !== entry.version) {
      problems.push(`${name} is ${version}; the lockfile pins ${entry.version}`)
    }
  }

  return problems
}

async function installedTree(path: string): Promise<string | undefined> {
  try {
    const tree = await realpath(path)
    return (await lstat(tree)).isDirectory() ? tree : undefined
  } catch (error) {
    if (missing(error)) {
      return undefined
    }

    throw error
  }
}

/** Link each nested dependency tree installed in the trusted checkout into a disposable command
 * copy, so a package below the root resolves the versions its own lockfile pins. The root tree is
 * linked when the copy is created. A tree that differs from the copy's lockfile stops the command:
 * skipping the link would let resolution climb to a parent tree and load another version.
 * Returns the linked trees, which an isolated command may read and can never write. */
export async function linkLockedDependencies(
  probe: string,
  trustedRoot: string,
  names: Iterable<string>,
  execution: ExecutionPolicy,
): Promise<string[]> {
  const directories = nestedLockfiles(names)
  const root = directories.length ? await canonicalRoot(trustedRoot) : undefined
  const linked: string[] = []

  // A project without nested lockfiles, or without a checkout to link from, has nothing to add.
  if (root === undefined) {
    return linked
  }

  for (const directory of directories) {
    const name = directory + lockfileSuffix
    const tree = await installedTree(join(root, directory, 'node_modules'))

    if (!tree) {
      continue
    }

    if (linked.length === linkedTreeLimit) {
      throw new Error(`More than ${linkedTreeLimit} nested dependency trees; narrow the project`)
    }

    if (execution.mode !== 'trusted-local' && !tree.startsWith(root + sep)) {
      throw new Error(
        `Dependencies of ${directory} resolve outside the project; isolation hides them`,
      )
    }

    const problems = await lockedDependencyDrift(await readFile(join(probe, name), 'utf8'), tree)

    if (problems.length) {
      const listed = problems.slice(0, 8).join('; ')
      const more = problems.length > 8 ? `; ${problems.length - 8} more` : ''
      throw new Error(
        `Installed dependencies do not match ${name}: ${listed}${more}. ` +
          `Run npm ci in ${join(root, directory)} on the host, then retry.`,
      )
    }

    await symlink(tree, join(probe, directory, 'node_modules'))
    linked.push(tree)
  }

  return linked
}
