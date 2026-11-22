import { symlink, rm, chmod, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copySnapshot,
  matches,
  inventory,
  safePath,
  snapshotHash,
  validateScope,
  readBoundedFile,
} from './paths.ts'
import { atomicJson, readJson } from './state.ts'
import type { Project, ProjectCheck, Receipt } from './contracts.ts'
import { runOnHost, runSandboxed } from './sandbox.ts'
import { addGitIndex } from './probe-git.ts'
import { taskDirectory, temporaryDirectory, type TaskOwner } from './temp.ts'

export const harnessRoot = fileURLToPath(new URL('../', import.meta.url))
export const defaultDatabasePaths = [
  'db/**',
  'database/**',
  'migrations/**',
  'storage/**',
  'infra/**',
]

type ReadMetadata = <T>(path: string) => Promise<T | undefined>

export async function loadProject(
  root: string,
  read: ReadMetadata = (path) => readJson(join(root, path)),
): Promise<Project> {
  const adapter = await read<{
    checks?: ProjectCheck[]
    instrumentationPaths?: string[]
    databasePaths?: string[]
  }>('.pi/harness.json')
  const checks = adapter?.checks ?? []

  if (
    adapter &&
    Object.keys(adapter).some(
      (key) => !['checks', 'instrumentationPaths', 'databasePaths'].includes(key),
    )
  ) {
    throw new Error('Unknown project adapter field')
  }

  if (!adapter) {
    const pkg = await read<{ scripts?: Record<string, string> }>('package.json')
    const scripts = pkg?.scripts ?? {}
    const candidates = [
      ['static', 'verify'],
      ['test', 'test', 'test:unit', 'test:scaffold'],
      ['database', 'test:database', 'test:recovery'],
      ['benchmark', 'benchmark', 'test:performance'],
    ] as const

    for (const [kind, ...names] of candidates) {
      const name = names.find((key) => typeof scripts[key] === 'string' && scripts[key].trim())

      if (name) {
        checks.push({
          id: name.replaceAll(':', '-'),
          argv: ['npm', 'run', name],
          required: true,
          kind,
          timeoutMs: 120_000,
        })
      }
    }
  }

  if (checks.length > 20 || new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error('Project checks must have unique IDs, with a maximum of 20')
  }

  for (const check of checks) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/.test(check.id) ||
      !Array.isArray(check.argv) ||
      !check.argv.length ||
      check.argv.some((arg) => typeof arg !== 'string') ||
      typeof check.required !== 'boolean' ||
      !['test', 'database', 'benchmark', 'static'].includes(check.kind) ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      check.timeoutMs > 900_000 ||
      (check.runner !== undefined && !['sandbox', 'host'].includes(check.runner))
    ) {
      throw new Error('Invalid project check')
    }
  }

  const instrumentationPaths = adapter?.instrumentationPaths ?? []
  const databasePaths = adapter?.databasePaths ?? defaultDatabasePaths
  validateScope(instrumentationPaths)
  validateScope(databasePaths)
  return { root: resolve(root), checks, instrumentationPaths, databasePaths }
}

async function linkedDependency(root: string, name: string): Promise<string | null> {
  try {
    return await realpath(join(root, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function installedNodeModules(root: string): Promise<string | null> {
  return linkedDependency(root, 'node_modules')
}

/** The host virtual environment is linked read-only, like node_modules. */
export async function installedVirtualEnvironment(root: string): Promise<string | null> {
  return linkedDependency(root, '.venv')
}

export async function createWorkspace(
  root: string,
  snapshot?: Map<string, Buffer>,
  nodeModules?: string | null,
  owner?: TaskOwner,
): Promise<string> {
  const workspace = owner ? await taskDirectory(owner) : await temporaryDirectory('w')
  const files = snapshot ?? (await inventory(root))
  await copySnapshot(files, workspace)

  for (const name of files.keys()) {
    await chmod(join(workspace, name), (await stat(join(root, name))).mode & 0o777)
  }

  const modules = nodeModules === undefined ? await installedNodeModules(root) : nodeModules

  if (modules) {
    await symlink(modules, join(workspace, 'node_modules'))
  }

  const environment = nodeModules === null ? null : await installedVirtualEnvironment(root)

  if (environment && ![...files.keys()].some((name) => name.split('/')[0] === '.venv')) {
    await symlink(environment, join(workspace, '.venv'))
  }

  return workspace
}

export async function instructions(root: string, paths: string[]): Promise<string> {
  const names = new Set<string>(['AGENTS.md'])

  for (const name of paths) {
    let directory = dirname(name.replace(/\/\*\*$/, '/file'))

    while (directory !== '.' && directory !== '/') {
      names.add(`${directory}/AGENTS.md`)
      directory = dirname(directory)
    }
  }

  const sections: string[] = []

  for (const name of [...names].sort()) {
    try {
      const text = (await readBoundedFile(await safePath(root, name), 24000)).toString('utf8')

      if (text.length > 24000) {
        throw new Error(`Instruction file exceeds 24 KB: ${name}`)
      }

      sections.push(`Folder instructions ${name}:\n${text}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  return sections.join('\n\n')
}

export function hasSkippedTests(output: string): boolean {
  return (
    /\b[1-9]\d*\s+(?:skip|skipped|ignored|pending)\b/i.test(output) ||
    /\b(?:skipped|ignored|pending)\s*[:=]?\s*[1-9]\d*\b/i.test(output) ||
    /#\s*(?:SKIP|TODO)\b|^\s*--- SKIP:|^\s*SKIPPED\s+\[[1-9]\d*\]/im.test(output)
  )
}

type LintBaseline = { files: Map<string, Buffer>; writePaths: string[] }
type LintFinding = { name: string; key: string; line: string }

const harnessLintArgv = () => ['node', join(harnessRoot, 'scripts', 'linting', 'check.mjs'), '.']
const baselineFindings = new Map<string, Promise<string[]>>()

/** Parse harness-lint diagnostics. The run's completion marker states how many diagnostic lines
 * it printed; other lines (runtime warnings, say) are ignored. A missing marker or fewer parsed
 * diagnostics than it states leaves output unattributed and keeps the gate closed. */
export function lintFindings(output: string, prefix: string, files: Map<string, Buffer>) {
  const findings: LintFinding[] = []
  const marker = /^harness-lint complete: (\d+) diagnostic lines$/m.exec(output)

  for (const line of output.trim().split('\n')) {
    if (!line.trim() || /: \d+ inherited line-width findings?$/.test(line)) {
      continue
    }

    const diagnostic = /^([^:\r\n]+?)(?::(\d+))?: (.+)$/.exec(line)
    const raw = diagnostic?.[1]
    const name = raw?.startsWith(prefix + '/') ? raw.slice(prefix.length + 1) : raw
    const source = name ? files.get(name) : undefined

    if (!diagnostic || !name || !source) {
      continue
    }

    // Line numbers move with unrelated edits; the offending text identifies a finding.
    const [, , number, message] = diagnostic
    const text = number ? (source.toString('utf8').split(/\r?\n/)[Number(number) - 1] ?? '') : ''
    findings.push({
      name,
      key: [name, message, text].join('\0'),
      line: name + line.slice(raw!.length),
    })
  }

  return { findings, unknown: !marker || findings.length < Number(marker[1]) }
}

async function lintBaselineFindings(baseline: LintBaseline, signal?: AbortSignal) {
  const hash = snapshotHash(baseline.files)
  let pending = baselineFindings.get(hash)

  if (!pending) {
    pending = (async () => {
      const directory = await realpath(await temporaryDirectory('l'))

      try {
        await copySnapshot(baseline.files, directory)
        const result = await runSandboxed(directory, harnessLintArgv(), 120_000, signal)

        if (result.exitCode === 0) {
          return []
        }

        if (result.exitCode !== 1 || result.timedOut || result.aborted || result.truncated) {
          throw new Error('Baseline harness-lint did not complete')
        }

        return lintFindings(result.output, directory, baseline.files).findings.map(
          (finding) => finding.key,
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })()
    baselineFindings.set(hash, pending)
    pending.catch(() => baselineFindings.delete(hash))
  }

  return pending
}

/** Findings already present on the base commit are reported as debt and never block a task.
 * A finding blocks only when the candidate adds an occurrence the base did not have. */
async function attributeLintFindings(
  output: string,
  probe: string,
  files: Map<string, Buffer>,
  baseline: LintBaseline,
  signal?: AbortSignal,
): Promise<Pick<Receipt, 'inheritedLintPaths' | 'scopedLintOutput'> & { blocking: boolean }> {
  const candidate = lintFindings(output, probe, files)
  const remaining = new Map<string, number>()

  for (const key of await lintBaselineFindings(baseline, signal)) {
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  const inherited = new Set<string>()
  let scoped = ''

  for (const finding of candidate.findings) {
    const count = remaining.get(finding.key) ?? 0

    if (count > 0) {
      remaining.set(finding.key, count - 1)
      inherited.add(finding.name)
      continue
    }

    if (scoped.length < 4000) {
      scoped += finding.line + '\n'
    }
  }

  return {
    blocking: Boolean(scoped) || candidate.unknown || !candidate.findings.length,
    ...(inherited.size > 0 && { inheritedLintPaths: [...inherited] }),
    ...(scoped && { scopedLintOutput: scoped.slice(0, 4000).trimEnd() }),
  }
}

type CheckRun = { check: ProjectCheck; probe: string; argv: string[] }

async function runCheck(
  workspace: string,
  files: Map<string, Buffer>,
  check: ProjectCheck,
  project: Project,
  signal: AbortSignal | undefined,
  prepare?: (run: CheckRun) => Promise<string[]>,
) {

  // Every command receives a disposable copy, so test code cannot alter the reviewed candidate.
  const probe = await realpath(await createWorkspace(workspace, files))

  try {
    const git = await addGitIndex(probe, workspace, project.root)
    const argv = prepare ? await prepare({ check, probe, argv: check.argv }) : check.argv
    const result =
      check.runner === 'host'
        ? await runOnHost(probe, argv, check.timeoutMs, signal)
        : await runSandboxed(probe, argv, check.timeoutMs, signal, { readable: git })
    return { probe, result }
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}

function checkStatus(result: Receipt['result'], tests: boolean): Receipt['status'] {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated) {
    return 'failed'
  }

  return tests && hasSkippedTests(result.output) ? 'skipped' : 'passed'
}

/** Behavioral checks run first and all report. Harness lint and host checks form the final gate:
 * they run only once every sandbox check passes, so earlier repair rounds never see them. */
export async function verifyProject(
  workspace: string,
  project: Project,
  database: boolean,
  signal?: AbortSignal,
  baseline?: LintBaseline,
): Promise<Receipt[]> {
  const files = await inventory(workspace)
  const hash = snapshotHash(files)
  const ignore = files.get('.prettierignore')
  const retained =
    baseline && ignore && baseline.files.get('.prettierignore')?.equals(ignore)
      ? [...files]
          .filter(
            ([name, bytes]) =>
              name.endsWith('.md') &&
              baseline.files.get(name)?.equals(bytes) &&
              !baseline.writePaths.some((scope) => matches(name, scope)),
          )
          .map(([name]) => name)
      : []
  const checks = project.checks.filter((check) => check.kind !== 'benchmark')
  const receipts: Receipt[] = []
  let open = true

  for (const check of checks.filter((item) => item.runner !== 'host')) {
    const { result } = await runCheck(workspace, files, check, project, signal)
    const status = checkStatus(result, true)
    receipts.push({ snapshot: hash, check: check.id, status, result })
    open &&= status === 'passed' || !check.required
  }

  if (open) {
    const lint: ProjectCheck = {
      id: 'harness-lint',
      argv: harnessLintArgv(),
      required: true,
      kind: 'static',
      timeoutMs: 120_000,
    }
    let probeRoot = ''
    const { result } = await runCheck(workspace, files, lint, project, signal, async (run) => {
      probeRoot = run.probe

      if (!retained.length) {
        return run.argv
      }

      const manifest = '.pi/traces/retained-markdown.json'
      await atomicJson(join(run.probe, manifest), retained)
      return [...run.argv, '--retained-markdown', manifest]
    })
    let status = checkStatus(result, false)
    let attribution: Awaited<ReturnType<typeof attributeLintFindings>> | undefined

    if (
      status === 'failed' &&
      baseline &&
      result.exitCode === 1 &&
      !result.timedOut &&
      !result.aborted &&
      !result.truncated
    ) {
      attribution = await attributeLintFindings(result.output, probeRoot, files, baseline, signal)
      status = attribution.blocking ? 'failed' : 'passed'
    }

    receipts.unshift({
      snapshot: hash,
      check: lint.id,
      status,
      result,
      ...(attribution?.inheritedLintPaths && {
        inheritedLintPaths: attribution.inheritedLintPaths,
      }),
      ...(attribution?.scopedLintOutput && { scopedLintOutput: attribution.scopedLintOutput }),
    })
    open = status === 'passed'
  }

  for (const check of checks.filter((item) => item.runner === 'host')) {
    if (!open) {
      break
    }

    const { result } = await runCheck(workspace, files, check, project, signal)
    const status = checkStatus(result, true)
    receipts.push({ snapshot: hash, check: check.id, status, result })
    open = status === 'passed' || !check.required
  }

  for (const kind of ['test', ...(database ? ['database'] : [])]) {
    if (!project.checks.some((check) => check.kind === kind && check.required)) {
      receipts.push({
        snapshot: hash,
        check: `required-${kind}`,
        status: 'unavailable',
        result: {
          argv: [],
          exitCode: null,
          output: `Declare a required ${kind} check in .pi/harness.json`,
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 0,
        },
      })
    }
  }

  return receipts
}

export function projectRelative(root: string, path: string): string {
  return relative(root, path)
}
