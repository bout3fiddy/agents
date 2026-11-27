import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safePath, sensitive } from './paths.ts'

/**
 * Git is the durable record of a job: where it started, its latest state and its result are
 * commits kept alive by private refs. Work itself happens in disposable copies, so no worktree
 * is registered and nothing here touches the user's index, HEAD or stash.
 */
export type Repository = {

  /** Object and ref store: the repository's common Git directory, or a private shadow. */
  gitDir: string

  /** A directory without Git gets a shadow store. It can apply results but not publish them. */
  shadow: boolean

  /** Top of the checkout the job targets. Commits always hold paths relative to it. */
  top: string

  /** The job's own directory below the top: '' or a path ending in a slash. */
  prefix: string
}

const objectId = /^[0-9a-f]{40,64}$/
const harnessIdentity = {
  GIT_AUTHOR_NAME: 'Pi harness',
  GIT_AUTHOR_EMAIL: 'pi-harness@localhost',
  GIT_COMMITTER_NAME: 'Pi harness',
  GIT_COMMITTER_EMAIL: 'pi-harness@localhost',
}

type GitOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; raw?: boolean }

function run(args: string[], options: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
        encoding: 'buffer',
        maxBuffer: 256_000_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString().trim().slice(0, 2000)
          reject(new Error(`git ${args[0]} failed: ${detail || error.message}`))
        } else {
          resolve(stdout)
        }
      },
    )
    child.stdin?.end(options.input ?? '')
  })
}

async function git(repo: Repository, args: string[], options: GitOptions = {}): Promise<string> {
  const output = await run(args, {
    ...options,
    env: { GIT_DIR: repo.gitDir, ...options.env },
  })
  return options.raw ? output.toString() : output.toString().trim()
}

/** The repository holding root's history, or a shadow store when root is not under Git. */
export async function openRepository(root: string, stateDirectory: string): Promise<Repository> {
  try {
    const answers = await run([
      '-C',
      root,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--show-toplevel',
      '--show-prefix',
    ])
    const [gitDir, top, prefix] = answers.toString().split('\n')
    return { gitDir: gitDir!, shadow: false, top: top!, prefix: prefix ?? '' }
  } catch {
    const gitDir = join(stateDirectory, 'shadow.git')
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    await run(['init', '--quiet', '--bare', gitDir])
    return { gitDir, shadow: true, top: root, prefix: '' }
  }
}

export async function resolveCommit(
  repo: Repository,
  reference: string,
  cwd?: string,
): Promise<string | undefined> {
  try {
    const id = await git(repo, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`], {
      cwd,
    })
    return objectId.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** The commit root has checked out. HEAD belongs to the checkout, not to the shared store. */
export async function checkoutHead(root: string): Promise<string | undefined> {
  try {
    const id = (await run(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))
      .toString()
      .trim()
    return objectId.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

type TreeEntry = { mode: string; path: string }

async function withIndex<T>(action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-index-'))

  try {
    return await action({ GIT_INDEX_FILE: join(directory, 'index') })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function indexEntries(repo: Repository, env: NodeJS.ProcessEnv): Promise<TreeEntry[]> {
  const listing = await git(repo, ['ls-files', '--stage', '-z'], { env, raw: true })
  return listing
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ mode: line.slice(0, 6), path: line.slice(line.indexOf('\t') + 1) }))
}

/** Regular files of the job's directory that a worker may see: no links, submodules,
 * credentials or private state. */
const visible = (repo: Repository) => (entry: TreeEntry) =>
  entry.mode.startsWith('100') &&
  entry.path.startsWith(repo.prefix) &&
  !sensitive(entry.path.slice(repo.prefix.length))

export type CommitInput = {

  /** Tree to start from. Absent: an empty tree. */
  from?: string

  /** Directory laid out like the checkout from its top, holding the content of the paths. */
  directory: string

  /** Paths below the job's directory to refresh: present files are stored, missing removed. */
  paths: string[]
  parents: string[]
  message: string

  /** A commit the user will publish carries their identity; private ones carry the harness's. */
  identity?: 'user'
}

/** Record directory's state of the named paths, on top of a tree, as one commit. */
export async function commitPaths(repo: Repository, input: CommitInput): Promise<string> {
  return withIndex(async (index) => {
    const env = { ...index, GIT_WORK_TREE: input.directory }

    if (input.from) {
      await git(repo, ['read-tree', input.from], { env })
    }

    if (input.paths.length) {
      await git(repo, ['update-index', '--add', '--remove', '-z', '--stdin'], {
        env,
        cwd: input.directory,
        input: input.paths.map((path) => repo.prefix + path).join('\0') + '\0',
      })
    }

    const tree = await git(repo, ['write-tree'], { env })
    const identified =
      input.identity === 'user' && (await git(repo, ['config', 'user.email']).catch(() => ''))
    return git(
      repo,
      ['commit-tree', tree, ...input.parents.flatMap((parent) => ['-p', parent]), '-F', '-'],
      { env: identified ? {} : harnessIdentity, input: input.message + '\n' },
    )
  })
}

/**
 * The job directory's working tree as a commit: tracked and untracked authored files exactly as
 * they stand, without staging, stashing or moving HEAD. names is that directory's inventory.
 * The rest of the checkout is recorded as HEAD has it.
 */
export async function snapshotCheckout(repo: Repository, names: Iterable<string>): Promise<string> {
  const head = repo.shadow ? undefined : await checkoutHead(repo.top)
  const tracked = head
    ? await withIndex(async (env) => {
        await git(repo, ['read-tree', head], { env })
        return (await indexEntries(repo, env))
          .filter(visible(repo))
          .map((entry) => entry.path.slice(repo.prefix.length))
      })
    : []
  return commitPaths(repo, {
    from: head,
    directory: repo.top,
    paths: [...new Set([...names, ...tracked])],
    parents: head ? [head] : [],
    message: 'Pi harness snapshot of the working tree',
  })
}

/**
 * Write the visible files of the job's directory, as a commit has them, below an empty
 * directory. Returns the copy of the job's directory inside it.
 */
export async function materialize(
  repo: Repository,
  commit: string,
  directory: string,
): Promise<string> {
  const workspace = join(directory, repo.prefix)
  await mkdir(workspace, { recursive: true })
  await withIndex(async (index) => {
    const env = { ...index, GIT_WORK_TREE: directory }
    await git(repo, ['read-tree', commit], { env })
    const paths = (await indexEntries(repo, env)).filter(visible(repo)).map((entry) => entry.path)

    if (paths.length) {
      await git(repo, ['checkout-index', '-z', '--stdin', `--prefix=${directory}/`], {
        env,
        input: paths.join('\0') + '\0',
      })
    }
  })
  return workspace
}

/** Paths below the job's directory that differ between two commits. */
export async function changedPaths(
  repo: Repository,
  base: string,
  head: string,
): Promise<string[]> {
  const listing = await git(repo, ['diff', '--name-only', '--no-renames', '-z', base, head], {
    raw: true,
  })
  return listing
    .split('\0')
    .filter((path) => path && path.startsWith(repo.prefix))
    .map((path) => path.slice(repo.prefix.length))
    .sort()
}

async function blob(repo: Repository, commit: string, path: string) {
  const entry = await git(repo, ['ls-tree', '-z', commit, '--', repo.prefix + path], { raw: true })
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(entry)
  return match ? { mode: match[1]!, id: match[2]! } : undefined
}

async function workingBlob(repo: Repository, path: string) {
  try {
    await safePath(repo.top, repo.prefix + path)
    return await git(repo, ['hash-object', '--', repo.prefix + path], {
      cwd: repo.top,
      env: { GIT_WORK_TREE: repo.top },
    })
  } catch {
    return undefined
  }
}

/**
 * Apply base..head to the checkout's working tree. A path is written only where the checkout
 * still holds what the job started from, or already holds the result; anything else is the
 * user's concurrent edit, and then nothing at all is written.
 */
export async function applyToCheckout(
  repo: Repository,
  base: string,
  head: string,
): Promise<{ applied: string[]; conflicts: string[] }> {
  const paths = await changedPaths(repo, base, head)
  const plan: { path: string; target?: { mode: string; id: string } }[] = []
  const conflicts: string[] = []

  for (const path of paths) {
    const [before, target, current] = await Promise.all([
      blob(repo, base, path),
      blob(repo, head, path),
      workingBlob(repo, path),
    ])

    if (current !== before?.id && current !== target?.id) {
      conflicts.push(path)
    }

    plan.push({ path, target })
  }

  if (conflicts.length) {
    return { applied: [], conflicts }
  }

  for (const { path, target } of plan) {
    const destination = await safePath(repo.top, repo.prefix + path)

    if (!target) {
      await rm(destination, { force: true })
      continue
    }

    const bytes = await run(['cat-file', 'blob', target.id], { env: { GIT_DIR: repo.gitDir } })
    const temporary = `${destination}.${randomUUID()}.tmp`
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(temporary, bytes)
    await chmod(temporary, target.mode === '100755' ? 0o755 : 0o644)
    await rename(temporary, destination)
  }

  return { applied: paths, conflicts: [] }
}

export function validBranch(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(name) && !name.includes('..')
}

export async function branchTip(repo: Repository, branch: string): Promise<string | undefined> {
  return resolveCommit(repo, `refs/heads/${branch}`)
}

/**
 * Point a local branch at the result. The branch must still be where the job started, and must
 * not be checked out anywhere, so no working tree is left behind its own branch.
 */
export async function advanceBranch(
  repo: Repository,
  branch: string,
  head: string,
  expected: string | undefined,
): Promise<void> {
  const worktrees = await git(repo, ['worktree', 'list', '--porcelain'])

  if (worktrees.split('\n').includes(`branch refs/heads/${branch}`)) {
    throw new Error(
      `Branch ${branch} is checked out in a worktree. The result is kept at ${head}; ` +
        'merge it there, or deliver to a branch that is not checked out.',
    )
  }

  await git(repo, ['update-ref', `refs/heads/${branch}`, head, expected ?? '0'.repeat(40)])
}

const jobRef = (id: string, name: string) => `refs/pi/jobs/${id}/${name}`

/** Keep a job's commit reachable. */
export async function pin(repo: Repository, id: string, name: string, commit: string) {
  await git(repo, ['update-ref', jobRef(id, name), commit])
}

export async function unpin(repo: Repository, id: string): Promise<void> {
  const refs = await git(repo, ['for-each-ref', '--format=%(refname)', `refs/pi/jobs/${id}/`])

  for (const name of refs.split('\n').filter(Boolean)) {
    await git(repo, ['update-ref', '-d', name])
  }
}
