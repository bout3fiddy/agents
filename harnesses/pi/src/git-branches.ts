import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireLock } from './lock.ts'
import {
  inventory,
  readBoundedFile,
  safePath,
  snapshotHash,
  validateScope,
  writable,
} from './paths.ts'
import { projectTraces } from './traces.ts'

export type GitTarget = { remote: string; target: string }
export type GitRepository = GitTarget & {
  root: string
  commonDir: string
  remoteUrl: string
  base: string
}
export type GitBranch = GitRepository & { workspace: string; branch: string }
export type CandidateCheckout = Pick<GitBranch, 'root' | 'workspace' | 'branch' | 'base'>
export type BranchPublication = {
  message: string
  writePaths: string[]
  expectedSnapshot: string
}
export type MergeValidation = { workspace: string; baseTip: string; conflicts: string[] }
export type MergeOptions = {
  message: string
  writePaths: string[]
  validate: (state: MergeValidation) => Promise<string>
  afterBranchPush?: (state: { commit: string; baseTip: string }) => Promise<string | void>
}

const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const outputLimit = 2_000_000

export class GitCommandError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message)
  }
}

/** Host-only Git operations. Workers never receive this command runner. */
async function executeGit(
  root: string,
  args: string[],
  signal?: AbortSignal,
  overrides: string[] = [],
): Promise<string> {
  signal?.throwIfAborted()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  const options = [
    '-C',
    root,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'tag.gpgSign=false',
    '-c',
    'merge.autoStash=false',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'merge.default=text',
    ...overrides.flatMap((value) => ['-c', value]),
  ]
  return new Promise((accept, reject) => {
    const child = spawn('git', [...options, ...args], {
      cwd: root,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let escalation: NodeJS.Timeout | undefined
    const stop = (error: Error) => {
      failure ??= error

      if (escalation || !child.pid) {
        return
      }

      const kill = (kind: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, kind)
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') {
            failure = killError as Error
          }
        }
      }
      kill('SIGTERM')
      escalation = setTimeout(() => kill('SIGKILL'), 1000)
    }
    const abort = () => stop(new Error('Git operation cancelled'))
    const timer = setTimeout(() => stop(new Error('Git operation exceeded 120 seconds')), 120_000)
    signal?.addEventListener('abort', abort, { once: true })

    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      stream.on('data', (chunk: Buffer) => {
        if (stdout.length + stderr.length + chunk.length > outputLimit) {
          stop(new Error('Git operation exceeded the output limit'))
          return
        }

        if (name === 'stdout') {
          stdout += chunk.toString()
        } else {
          stderr += chunk.toString()
        }
      })
    }

    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(escalation)
      signal?.removeEventListener('abort', abort)

      if (failure) {
        reject(failure)
      } else if (code !== 0) {
        reject(new GitCommandError(code, `Git ${args[0]} failed: ${stderr.slice(-8000)}`))
      } else {
        accept(stdout.trimEnd())
      }
    })

    if (signal?.aborted) {
      abort()
    }
  })
}

export async function gitCommand(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const configured = await executeGit(
    root,
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^(filter|merge)\\..*\\.(clean|smudge|process|driver|required)$',
    ],
    signal,
  ).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.code === 1) {
      return ''
    }

    throw error
  })
  const groups = new Set(
    configured
      .split('\0')
      .filter(Boolean)
      .map((key) => key.slice(0, key.lastIndexOf('.'))),
  )
  const overrides = [...groups].flatMap((key) =>
    key.startsWith('filter.')
      ? [`${key}.clean=`, `${key}.smudge=`, `${key}.process=`, `${key}.required=false`]
      : [`${key}.driver=false`],
  )

  return executeGit(root, args, signal, overrides)
}

function ref(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(value) || value.includes('..')) {
    throw new Error('Invalid remote or branch name')
  }
}

async function endpoint(root: string, remote: string, signal?: AbortSignal): Promise<string> {
  const fetch = (await gitCommand(root, ['remote', 'get-url', '--all', remote], signal)).split('\n')
  const push = (
    await gitCommand(root, ['remote', 'get-url', '--push', '--all', remote], signal)
  ).split('\n')

  if (fetch.length !== 1 || push.length !== 1 || fetch[0] !== push[0] || !fetch[0]) {
    throw new Error('Branch tasks require one matching fetch and push remote URL')
  }

  return fetch[0]
}

async function fetchTip(repository: GitRepository, signal?: AbortSignal): Promise<string> {
  if ((await endpoint(repository.root, repository.remote, signal)) !== repository.remoteUrl) {
    throw new Error('The configured Git remote changed during the task')
  }

  // FETCH_HEAD is shared between worktrees; a private destination avoids cross-task races.
  const destination = `refs/pi-harness/fetch/${randomUUID()}`
  await gitCommand(
    repository.root,
    [
      'fetch',
      '--no-write-fetch-head',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      repository.remoteUrl,
      `refs/heads/${repository.target}:${destination}`,
    ],
    signal,
  )

  try {
    const tip = await gitCommand(repository.root, ['rev-parse', `${destination}^{commit}`], signal)

    if (!objectId.test(tip)) {
      throw new Error('Invalid remote commit identity')
    }

    return tip
  } finally {
    await gitCommand(repository.root, ['update-ref', '-d', destination])
  }
}

export async function resolveRemote(
  root: string,
  target: GitTarget = { remote: 'origin', target: 'main' },
  signal?: AbortSignal,
): Promise<GitRepository> {
  ref(target.remote)
  ref(target.target)
  const directory = await realpath(root)
  const top = await realpath(await gitCommand(directory, ['rev-parse', '--show-toplevel'], signal))

  if (top !== directory) {
    throw new Error('Branch orchestration must start at the Git repository root')
  }

  await gitCommand(directory, ['check-ref-format', `refs/heads/${target.target}`], signal)
  const common = await gitCommand(directory, ['rev-parse', '--git-common-dir'], signal)
  const repository = {
    ...target,
    root: directory,
    commonDir: await realpath(isAbsolute(common) ? common : resolve(directory, common)),
    remoteUrl: await endpoint(directory, target.remote, signal),
    base: '',
  }
  repository.base = await fetchTip(repository, signal)
  return repository
}

export async function prepareBranch(
  root: string,
  id: string,
  target: GitTarget & { base?: string; expectedRemoteUrl?: string } = {
    remote: 'origin',
    target: 'main',
  },
  signal?: AbortSignal,
): Promise<GitBranch> {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) {
    throw new Error('Branch tasks require a unique task UUID')
  }

  const repository = await resolveRemote(root, target, signal)
  const base = target.base ?? repository.base

  if (target.expectedRemoteUrl && target.expectedRemoteUrl !== repository.remoteUrl) {
    throw new Error('The configured Git remote changed before worktree creation')
  }

  if (!objectId.test(base)) {
    throw new Error('Invalid pinned branch base')
  }

  await gitCommand(root, ['merge-base', '--is-ancestor', base, repository.base], signal)
  const directory = join(projectTraces(repository.root), 'harness', 'worktrees')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const workspace = join(directory, id)
  const branch = `pi/${id}`
  await gitCommand(root, ['worktree', 'add', '-b', branch, '--', workspace, base], signal)
  return { ...repository, base, branch, workspace: await realpath(workspace) }
}

export async function currentCommit(
  branch: Pick<GitBranch, 'workspace'>,
  signal?: AbortSignal,
): Promise<string> {
  return gitCommand(branch.workspace, ['rev-parse', 'HEAD'], signal)
}

export async function prepareBaseline(
  branch: GitBranch,
  baseTip: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!objectId.test(baseTip)) {
    throw new Error('Invalid baseline commit identity')
  }

  await branchIdentity(branch, signal)
  await gitCommand(branch.root, ['worktree', 'add', '--detach', '--', destination, baseTip], signal)
  return realpath(destination)
}

export const remoteMain = fetchTip

async function branchIdentity(branch: GitBranch, signal?: AbortSignal): Promise<void> {
  const actual = await gitCommand(branch.workspace, ['symbolic-ref', '--short', 'HEAD'], signal)

  if (actual !== branch.branch) {
    throw new Error('Task worktree changed branches')
  }

  if ((await endpoint(branch.root, branch.remote, signal)) !== branch.remoteUrl) {
    throw new Error('The configured Git remote changed during the task')
  }
}

async function commitCandidate(
  branch: GitBranch,
  publication: BranchPublication,
  baseline: string,
  signal?: AbortSignal,
): Promise<string> {
  await branchIdentity(branch, signal)
  return commitVerifiedTree(branch, publication, baseline, signal)
}

/** Stage only scoped changes and validate the committed tree against the checked snapshot. */
export async function commitVerifiedTree(
  branch: CandidateCheckout,
  publication: BranchPublication,
  baseline: string,
  signal?: AbortSignal,
  beforeCommit?: (tree: string) => Promise<void>,
): Promise<string> {
  validateScope(publication.writePaths)
  const current = await gitCommand(branch.workspace, ['symbolic-ref', '--short', 'HEAD'], signal)

  if (current !== branch.branch) {
    throw new Error('Task worktree changed branches before commit')
  }

  const reviewed = await inventory(branch.workspace)

  if (snapshotHash(reviewed) !== publication.expectedSnapshot) {
    throw new Error('Task candidate changed after verification')
  }

  const paths = ['.']
  const modules = join(branch.workspace, 'node_modules')
  const dependencyLink = await lstat(modules).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }

    return undefined
  })

  // A directory-only ignore rule matches installed modules but not our worktree symlink.

  if (dependencyLink?.isSymbolicLink()) {
    if (
      (await realpath(modules)) !== (await realpath(join(branch.root, 'node_modules'))) ||
      (await gitCommand(branch.workspace, ['ls-files', '--', 'node_modules'], signal))
    ) {
      throw new Error('Unexpected dependency link in candidate worktree')
    }

    paths.push(':(top,exclude)node_modules')
  }

  const names = [
    await gitCommand(branch.workspace, ['diff', '--name-only', '-z', baseline, '--'], signal),
    await gitCommand(
      branch.workspace,
      ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths],
      signal,
    ),
  ].flatMap((value) => value.split('\0').filter(Boolean))

  for (const path of new Set(names)) {
    if (!writable(path, publication.writePaths)) {
      throw new Error(`Branch changed a path outside its assignment: ${path}`)
    }

    await safePath(branch.workspace, path)
  }

  // The final diff against current main was scoped above, including deletions and index changes.
  await gitCommand(branch.workspace, ['add', '-A', '--', ...paths], signal)

  if (
    await gitCommand(branch.workspace, ['diff', '--name-only', '--diff-filter=U', '-z'], signal)
  ) {
    throw new Error('Unresolved merge conflicts prevent publication')
  }

  const staged = await gitCommand(
    branch.workspace,
    ['diff', '--cached', '--name-only', '-z'],
    signal,
  )
  const merging = await gitCommand(
    branch.workspace,
    ['rev-parse', '--verify', 'MERGE_HEAD'],
    signal,
  )
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof GitCommandError && error.code === 128) {
        return false
      }

      throw error
    })

  if (beforeCommit) {
    await beforeCommit(await gitCommand(branch.workspace, ['write-tree'], signal))
  }

  if (staged || merging) {
    await gitCommand(
      branch.workspace,
      ['commit', '--no-gpg-sign', '-m', publication.message],
      signal,
    )
  }

  if (snapshotHash(await inventory(branch.workspace)) !== publication.expectedSnapshot) {
    throw new Error('Task snapshot changed during commit')
  }

  await verifyCommittedTree(branch, reviewed, signal)
  return currentCommit(branch, signal)
}

async function verifyCommittedTree(
  branch: CandidateCheckout,
  reviewed: Map<string, Buffer>,
  signal?: AbortSignal,
): Promise<void> {
  const format = await gitCommand(branch.workspace, ['rev-parse', '--show-object-format'], signal)

  if (!['sha1', 'sha256'].includes(format)) {
    throw new Error('Unsupported Git object format')
  }

  const listing = await gitCommand(branch.workspace, ['ls-tree', '-r', '-z', 'HEAD'], signal)
  const blobs = new Map(
    listing
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('\t')
        const [mode, kind, hash] = entry.slice(0, separator).split(' ')
        return [entry.slice(separator + 1), { mode, kind, hash }] as const
      }),
  )

  for (const [path, content] of reviewed) {
    const actual = blobs.get(path)
    const mode = (await stat(await safePath(branch.workspace, path))).mode & 0o111
    const expected = createHash(format)
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex')

    if (
      actual?.kind !== 'blob' ||
      actual.mode !== (mode ? '100755' : '100644') ||
      actual.hash !== expected
    ) {
      throw new Error(`Committed bytes differ from the reviewed snapshot: ${path}`)
    }
  }
}

async function pushBranch(branch: GitBranch, commit: string, signal?: AbortSignal): Promise<void> {
  await branchIdentity(branch, signal)
  await gitCommand(
    branch.root,
    ['push', '--porcelain', '--', branch.remoteUrl, `${commit}:refs/heads/${branch.branch}`],
    signal,
  )
}

export async function publishBranch(
  branch: GitBranch,
  publication: BranchPublication,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await commitCandidate(branch, publication, branch.base, signal)
  await pushBranch(branch, commit, signal)
  return commit
}

export async function acquireMergeLock(commonDir: string, signal?: AbortSignal) {
  for (;;) {
    signal?.throwIfAborted()

    try {
      return await acquireLock(join(commonDir, 'pi-harness-merge.lock'))
    } catch (error) {
      if (!String(error).includes('already running')) {
        throw error
      }
    }

    await delay(1000, undefined, { signal })
  }
}

export async function mergeBranch(
  branch: GitBranch,
  options: MergeOptions,
  signal?: AbortSignal,
): Promise<{ commit: string; baseTip: string; attempts: number }> {
  const release = await acquireMergeLock(branch.commonDir, signal)

  try {
    for (let attempts = 1; Number.isSafeInteger(attempts); attempts++) {
      signal?.throwIfAborted()
      release.assertHeld()
      await branchIdentity(branch, signal)

      if (
        await gitCommand(
          branch.workspace,
          ['status', '--porcelain', '--untracked-files=all'],
          signal,
        )
      ) {
        throw new Error('Publish and verify a clean task branch before entering the merge queue')
      }

      const baseTip = await fetchTip(branch, signal)

      try {
        await gitCommand(
          branch.workspace,
          ['merge', '--no-verify-signatures', '--no-commit', '--no-ff', baseTip],
          signal,
        )
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.code !== 1) {
          throw error
        }
      }

      const conflicts = (
        await gitCommand(branch.workspace, ['diff', '--name-only', '--diff-filter=U', '-z'], signal)
      )
        .split('\0')
        .filter(Boolean)

      for (const path of conflicts) {
        if (!writable(path, options.writePaths)) {
          throw new Error(`Merge conflict exceeds task scope: ${path}`)
        }
      }

      const expectedSnapshot = await options.validate({
        workspace: branch.workspace,
        baseTip,
        conflicts,
      })
      signal?.throwIfAborted()
      release.assertHeld()

      for (const path of conflicts) {
        let content: Buffer

        try {
          content = await readBoundedFile(await safePath(branch.workspace, path))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue
          }

          throw error
        }

        if (/^(?:<<<<<<< |>>>>>>> )/m.test(content.toString('utf8'))) {
          throw new Error(`Unresolved conflict markers prevent publication: ${path}`)
        }
      }

      let commit = await commitCandidate(branch, { ...options, expectedSnapshot }, baseTip, signal)
      await gitCommand(branch.workspace, ['merge-base', '--is-ancestor', baseTip, commit], signal)
      await pushBranch(branch, commit, signal)
      let verifiedSnapshot = expectedSnapshot

      for (;;) {
        const revisedSnapshot = await options.afterBranchPush?.({ commit, baseTip })
        signal?.throwIfAborted()
        release.assertHeld()

        if ((await currentCommit(branch, signal)) !== commit) {
          throw new Error('Review callbacks may change files but cannot replace task commits')
        }

        if (revisedSnapshot === undefined) {
          if (snapshotHash(await inventory(branch.workspace)) !== verifiedSnapshot) {
            throw new Error('Review callback changed files without fresh validation evidence')
          }

          break
        }

        if (typeof revisedSnapshot !== 'string' || revisedSnapshot === verifiedSnapshot) {
          throw new Error('Review feedback must produce a changed, freshly validated snapshot')
        }

        const revisedCommit = await commitCandidate(
          branch,
          { ...options, expectedSnapshot: revisedSnapshot },
          baseTip,
          signal,
        )

        if (revisedCommit === commit) {
          throw new Error('Review feedback did not produce a new task commit')
        }

        await pushBranch(branch, revisedCommit, signal)
        commit = revisedCommit
        verifiedSnapshot = revisedSnapshot
      }

      // A concurrent remote writer wins normally; never force-update main or bypass protections.
      try {
        await gitCommand(
          branch.root,
          ['push', '--porcelain', '--', branch.remoteUrl, `${commit}:refs/heads/${branch.target}`],
          signal,
        )
      } catch (error) {
        signal?.throwIfAborted()
        const latest = await fetchTip(branch, signal)
        const merged = await gitCommand(
          branch.root,
          ['merge-base', '--is-ancestor', commit, latest],
          signal,
        )
          .then(() => true)
          .catch((ancestryError: unknown) => {
            if (ancestryError instanceof GitCommandError && ancestryError.code === 1) {
              return false
            }

            throw ancestryError
          })

        if (merged) {
          return { commit, baseTip, attempts }
        }

        if (latest === baseTip) {
          throw error
        }

        continue
      }

      return { commit, baseTip, attempts }
    }

    throw new Error('Merge attempt counter overflowed; branch retained')
  } finally {
    await release()
  }
}
