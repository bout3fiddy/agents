import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { gitCommand, GitCommandError } from './git-branches.ts'
import { acquireLock } from './lock.ts'
import { atomicJson, readJson, StateStore } from './state.ts'
import { safeTrace } from './workers-data.ts'

const interval = 10 * 60_000
const remoteRef = 'refs/remotes/origin/main'
const fetchFlags = [
  'fetch',
  '--no-tags',
  '--no-write-fetch-head',
  '--no-recurse-submodules',
  '--no-auto-maintenance',
]

// The isolated Git runner disables clean/smudge commands. Never materialize filtered files
// with those commands disabled in the user's own checkout.
async function needsCheckoutFilter(
  run: (args: string[]) => Promise<string>,
  local: string,
  remote: string,
) {
  const diff = await run(['diff', '--name-only', '--no-renames', '-z', local, remote, '--'])
  const paths = diff.split('\0').filter(Boolean)

  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32)

    for (const source of [[], ['--source=' + remote]]) {
      const attrs = await run(['check-attr', ...source, '-z', 'filter', '--', ...batch])

      if (
        attrs
          .split('\0')
          .some((value, i) => i % 3 === 2 && value !== 'unspecified' && value !== 'unset')
      ) {
        return true
      }
    }
  }

  return false
}

async function applyMain(cwd: string, signal: AbortSignal, idle: () => boolean) {
  const git = (args: string[]) => gitCommand(cwd, args, signal)
  const [local, remote] = await Promise.all([
    git(['rev-parse', '--verify', 'refs/heads/main']),
    git(['rev-parse', '--verify', remoteRef]),
  ])

  if (local === remote || !idle()) {
    return
  }

  const base = await git(['merge-base', local, remote])

  if (base === remote) {
    return
  }

  if (base !== local) {
    return 'Local and remote main have diverged.'
  }

  const worktrees = await git(['worktree', 'list', '--porcelain', '-z'])
  const tree = worktrees
    .split('\0\0')
    .find((item) => item.split('\0').includes('branch refs/heads/main'))

  if (!tree) {

    // Git refuses to update a checked-out branch and rechecks fast-forward ancestry itself.
    if (idle()) {
      await git([...fetchFlags, '.', remote + ':refs/heads/main'])
    }

    return
  }

  const main = tree.split('\0')[0]!.slice('worktree '.length)
  const run = (args: string[]) => gitCommand(main, args, signal)
  const directory = await run(['rev-parse', '--absolute-git-dir'])
  const operations = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_START',
    'sequencer',
    'rebase-apply',
    'rebase-merge',
    'index.lock',
  ]

  if (operations.some((file) => existsSync(join(directory, file)))) {
    return 'A Git operation is in progress on local main.'
  }

  if (await run(['diff', '--cached', '--name-only', '--no-ext-diff'])) {
    return 'Local main has staged changes.'
  }

  if (await needsCheckoutFilter(run, local, remote)) {
    return 'Local main needs a checkout filter. Sync it with your configured Git client.'
  }

  const store = existsSync(join(main, '.pi', 'traces', 'harness'))
    ? new StateStore(main)
    : undefined
  const path = store && (await safeTrace(store, join(store.directory, 'workflow.lock')))
  const release = path && (await acquireLock(path).catch(() => undefined))

  if (path && !release) {
    return 'A Pi workflow owns local main.'
  }

  try {
    if ((await run(['symbolic-ref', '--quiet', 'HEAD'])) !== 'refs/heads/main' || !idle()) {
      return
    }

    await run([
      '-c',
      'submodule.recurse=false',
      'merge',
      '--ff-only',
      '--no-squash',
      '--no-autostash',
      '--no-overwrite-ignore',
      remote,
    ])
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error
    }

    return 'Git could not fast-forward local main safely. Inspect git status.'
  } finally {
    if (release) {
      await release()
    }
  }
}

export async function syncMain(
  cwd: string,
  signal: AbortSignal,
  idle: () => boolean,
  afterMerge = false,
) {
  const git = (args: string[]) => gitCommand(cwd, args, signal)
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(
    () => undefined,
  )

  if (!common) {
    return
  }

  const upstream = await git(['for-each-ref', '--format=%(refname) %(upstream)', 'refs/heads/main'])

  if (upstream !== 'refs/heads/main' && upstream !== 'refs/heads/main ' + remoteRef) {
    return
  }

  const config = await git(['config', '--default', 'true', '--type=bool', '--get', 'pi.syncMain'])

  if (config !== 'true' || !(await git(['remote'])).split('\n').includes('origin')) {
    return
  }

  const release = await acquireLock(join(common, 'pi-main-sync.lock')).catch(() => undefined)

  if (!release) {
    return
  }

  try {
    const stamp = join(common, 'pi-main-sync.json')
    const url = await git(['remote', 'get-url', 'origin'])

    // Background refresh supports Git's standard transports, without launching remote helpers.

    if (
      /^[\w.+-]+::/.test(url) ||
      (/^[\w.+-]+:\/\//.test(url) && !/^(?:https?|ssh|git|file):\/\//.test(url))
    ) {
      return 'Automatic main sync does not support this remote transport.'
    }

    const source = createHash('sha256').update(url).digest('hex')
    const prior = await readJson<{ at: number; source: string; fetched: boolean }>(stamp)

    if (afterMerge || prior?.source !== source || Date.now() - prior.at >= interval) {
      const attempt = { at: Date.now(), source, fetched: false }
      await atomicJson(stamp, attempt)
      const network = AbortSignal.any([signal, AbortSignal.timeout(15000)])
      await gitCommand(cwd, [...fetchFlags, 'origin', 'refs/heads/main:' + remoteRef], network)
      await atomicJson(stamp, { ...attempt, fetched: true })
    } else if (!prior.fetched) {
      return 'Main sync deferred after an unsuccessful fetch.'
    }

    return await applyMain(cwd, signal, idle)
  } finally {
    await release()
  }
}

export function registerMainSync(pi: ExtensionAPI) {
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let next = 0
  let merged = false
  let running: Promise<void> | undefined

  const check = (ctx: ExtensionContext) => {
    const generation = controller
    const idle = () => {
      if (!generation || generation.signal.aborted) {
        return false
      }

      try {
        return ctx.isIdle() && !ctx.hasPendingMessages()
      } catch {

        // Pi can invalidate an SDK context before it delivers session_shutdown.
        generation.abort()
        clearInterval(timer)
        return false
      }
    }

    if (!generation || running || !idle() || (!merged && Date.now() < next)) {
      return
    }

    const afterMerge = merged
    merged = false
    next = Date.now() + interval
    running = syncMain(ctx.cwd, generation.signal, idle, afterMerge)
      .catch(() => 'Main sync deferred. Check Git connectivity or configuration.')
      .then((issue) => {
        if (!idle()) {
          next = 0
          return
        }

        if (ctx.mode === 'tui') {
          ctx.ui.setStatus('pi-main-sync', issue || undefined)
        }
      })
      .finally(() => {
        running = undefined
      })
  }
  pi.on('session_start', (_event, ctx) => {
    controller = new AbortController()
    next = 0
    merged = false
    check(ctx)
    timer = setInterval(() => check(ctx), 30000)
    timer.unref()
  })
  pi.on('agent_settled', (_event, ctx) => check(ctx))
  pi.on('tool_result', (event) => {
    if (
      event.toolName === 'bash' &&
      !event.isError &&
      typeof event.input.command === 'string' &&
      /(?:^|[;&|]\s*)\s*gh\s+pr\s+merge\b/.test(event.input.command)
    ) {
      merged = true
    }
  })
  pi.on('session_shutdown', async () => {
    clearInterval(timer)
    controller?.abort()
    await running
  })
  return () => {
    merged = true
  }
}
