import { mkdtemp, symlink, rm, chmod, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { runSandboxed } from './sandbox.ts'

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
      check.timeoutMs > 900_000
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

export async function createWorkspace(
  root: string,
  snapshot?: Map<string, Buffer>,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-workspace-'))
  const files = snapshot ?? (await inventory(root))
  await copySnapshot(files, workspace)

  for (const name of files.keys()) {
    await chmod(join(workspace, name), (await stat(join(root, name))).mode & 0o777)
  }

  try {
    await symlink(
      await import('node:fs/promises').then((fs) => fs.realpath(join(root, 'node_modules'))),
      join(workspace, 'node_modules'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
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

/** Attribute a complete harness-lint failure only when every diagnostic names unchanged,
 * out-of-scope input. Unknown or mixed diagnostics follow the ordinary repair path. */
function inheritedLintPaths(
  output: string,
  probe: string,
  files: Map<string, Buffer>,
  baseline: LintBaseline,
): string[] | undefined {
  const paths = new Set<string>()

  for (const line of output.trim().split('\n')) {
    const diagnostic = /^([^:\r\n]+)(?::\d+)?: (.+)$/.exec(line)

    if (!diagnostic) {
      return undefined
    }

    const [, raw, message] = diagnostic
    const name = raw!.startsWith(probe + '/') ? raw!.slice(probe.length + 1) : raw!
    const bytes = files.get(name)

    if (
      !bytes ||
      !baseline.files.get(name)?.equals(bytes) ||
      baseline.writePaths.some((scope) => matches(name, scope))
    ) {
      return undefined
    }

    if (
      ![
        'line exceeds 100 columns',
        'invalid JSON',
        'add a blank line between logical stages',
        'add a blank line before a standalone comment block',
        'separate logical stages and standalone comment blocks',
      ].includes(message!)
    ) {
      return undefined
    }

    paths.add(name)
  }

  return [...paths]
}

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
  const checks: ProjectCheck[] = [
    {
      id: 'harness-lint',
      argv: ['node', join(harnessRoot, 'scripts', 'linting', 'check.mjs'), '.'],
      required: true,
      kind: 'static',
      timeoutMs: 120_000,
    },
    ...project.checks.filter((check) => check.kind !== 'benchmark'),
  ]
  const receipts: Receipt[] = []

  for (const check of checks) {

    // Every command receives a disposable copy, so test code cannot alter the reviewed candidate.
    const probe = await realpath(await createWorkspace(workspace, files))
    let result

    try {
      let argv = check.argv

      if (check === checks[0] && retained.length) {
        const manifest = '.pi/traces/retained-markdown.json'
        await atomicJson(join(probe, manifest), retained)
        argv = [...argv, '--retained-markdown', manifest]
      }

      result = await runSandboxed(probe, argv, check.timeoutMs, signal)
    } finally {
      await rm(probe, { recursive: true, force: true })
    }

    const status =
      result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated
        ? 'failed'
        : check !== checks[0] && hasSkippedTests(result.output)
          ? 'skipped'
          : 'passed'
    const inherited =
      check === checks[0] &&
      baseline &&
      result.exitCode === 1 &&
      !result.timedOut &&
      !result.aborted &&
      !result.truncated
        ? inheritedLintPaths(result.output, probe, files, baseline)
        : undefined
    receipts.push({
      snapshot: hash,
      check: check.id,
      status,
      result,
      ...(inherited?.length && { inheritedLintPaths: inherited }),
    })

    if (status !== 'passed' && check.required) {
      return receipts
    }
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
