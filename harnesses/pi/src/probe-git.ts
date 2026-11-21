import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitCommand } from './git-branches.ts'

async function objectsDirectory(projectRoot: string): Promise<string | undefined> {
  try {
    const common = await gitCommand(projectRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    return await realpath(join(common, 'objects'))
  } catch {
    return undefined
  }
}

async function checkoutHead(source: string): Promise<string | undefined> {
  try {
    return await gitCommand(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
  } catch {
    return undefined
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
    }

    await git(['add', '--all'])
    return [objects]
  } catch {
    await rm(join(probe, '.git'), { recursive: true, force: true })
    return []
  }
}
