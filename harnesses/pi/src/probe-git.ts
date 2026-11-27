import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitCommand, GitCommandError } from './git-command.ts'

async function objectsDirectory(projectRoot: string): Promise<string | undefined> {
  try {
    const common = await gitCommand(projectRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    return await realpath(join(common, 'objects'))
  } catch (error) {

    // Outside a Git repository the copy simply has no Git metadata.
    if (error instanceof GitCommandError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

async function checkoutHead(source: string): Promise<string | undefined> {
  try {
    return await gitCommand(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
  } catch (error) {

    // A plain copy is not a checkout and has no HEAD of its own.
    if (error instanceof GitCommandError) {
      return undefined
    }

    throw error
  }
}

/** Give a disposable command copy read-only Git metadata. Its index lists the copied files. HEAD is
 * the checkout's pinned commit, or the project's HEAD when the source is a plain copy taken from
 * the project, so `git diff HEAD` and `--base HEAD` tools see the candidate's changes. Objects
 * resolve through alternates to the project repository, which the sandbox may read but not write.
 * Returns paths the sandbox must read. Any failure leaves the copy without Git metadata. */
export async function addGitIndex(
  probe: string,
  source: string,
  projectRoot: string,
): Promise<string[]> {
  const objects = await objectsDirectory(projectRoot)

  if (!objects) {
    return []
  }

  const git = (args: string[]) =>
    gitCommand(probe, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args])

  try {
    await git(['init', '--quiet'])
    await writeFile(join(probe, '.git', 'objects', 'info', 'alternates'), objects + '\n')
    const head = (await checkoutHead(source)) ?? (await checkoutHead(projectRoot))

    if (head) {
      await git(['update-ref', '--no-deref', 'HEAD', head])

      // Start from HEAD's index, as a checkout does. Tracked files that an ignore rule also
      // matches (a tracked .pi/harness.json below an ignored .pi, say) are then updated rather
      // than skipped, so they never appear deleted to tools that diff against HEAD.
      await git(['read-tree', 'HEAD'])
    }

    // The harness links host dependencies into each copy. A directory-only ignore rule such as
    // node_modules/ does not match those symlinks, so exclude them from the copy's own index.
    await writeFile(join(probe, '.git', 'info', 'exclude'), '/node_modules\n/.venv\n')
    await git(['add', '--all'])
    return [objects]
  } catch {
    await rm(join(probe, '.git'), { recursive: true, force: true })
    return []
  }
}
