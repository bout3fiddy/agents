import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  statSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { needsRestart, shellQuote } from './pi-host.ts'
import { readInstall, type LoadedRuntime } from './runtime-version.ts'

type Target = { cwd: string; file: string; id: string; directory: string; wrapper: string }

// Pi accepts a nonexistent --session path as a request to create one. Never turn a missing,
// replaced, or not-yet-flushed conversation into a successful-looking blank restart.
function checkTarget(target: Target): void {
  const { cwd, file, directory, wrapper } = target

  if (![cwd, file, directory, wrapper].every(isAbsolute)) {
    throw new Error('Recovery requires absolute session, project and launcher paths.')
  }

  accessSync(wrapper, constants.X_OK)
  accessSync(cwd, constants.X_OK)

  if (!statSync(wrapper).isFile() || !statSync(cwd).isDirectory()) {
    throw new Error('The installed wrapper or project is unavailable.')
  }

  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('The session path is not a regular file.')
    }

    const buffer = Buffer.alloc(64 * 1024)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, length).indexOf(10)
    const header = newline >= 0 && JSON.parse(buffer.toString('utf8', 0, newline))

    if (
      header?.type !== 'session' ||
      header.id !== target.id ||
      realpathSync(header.cwd) !== realpathSync(cwd)
    ) {
      throw new Error('The saved conversation or project no longer matches.')
    }
  } finally {
    closeSync(fd)
  }
}

// Called at Node exit, after Pi's normal shutdown, including terminal and credential cleanup.
// execve replaces this process: no second writer, intermediate shell, or token to consume twice.
function finishQuit(target: Target, reopen: boolean): void {
  process.once('exit', (code) => {
    if (code !== 0 || (!reopen && !existsSync(target.file))) {
      return
    }

    try {
      checkTarget(target)
      const argv = [target.wrapper, '--session-dir', target.directory, '--session', target.file]

      if (reopen && process.execve) {
        writeSync(1, '\nReopening this chat in the installed harness…\n')
        process.chdir(target.cwd)
        process.execve(target.wrapper, argv, process.env)
      }

      // A global bundle prints its own hint after extension teardown. Clearly supersede it.
      const resume = `cd ${shellQuote(target.cwd)} && ${argv.map(shellQuote).join(' ')}`

      if (/\p{Cc}/u.test(resume)) {
        throw new Error('Cannot display terminal control characters in a resume command.')
      }

      writeSync(1, `\nFor this harness chat, use this instead:\n${resume}\n`)
    } catch {

      // A signal-driven shutdown can also report quit, even after the terminal is gone.
      try {
        writeSync(2, '\nHarness recovery unavailable: check the saved chat, project and install.\n')
      } catch {
        // No terminal remains for a diagnostic. Never retry an exit-time write.
      }
    }
  })
}

async function targetFor(ctx: ExtensionContext, loaded: LoadedRuntime | undefined) {
  const install = await readInstall()

  if (!install || !loaded || !needsRestart(loaded.source, loaded.piHost, install)) {
    return
  }

  const session = ctx.sessionManager
  const file = session.getSessionFile()

  if (!file) {
    return
  }

  return {
    cwd: ctx.cwd,
    file,
    id: session.getSessionId(),
    directory: session.getSessionDir(),
    wrapper: install.wrapper,
  }
}

export function registerLauncherRecovery(
  pi: ExtensionAPI,
  current: () => LoadedRuntime | undefined,
  busy: () => boolean,
): void {
  let requested: Target | undefined
  const versionCheck = process.env.PI_SKIP_VERSION_CHECK
  let suppressed = false
  pi.on('session_start', (_event, ctx) => {
    const loaded = current()

    if (ctx.mode === 'tui' && loaded?.install && loaded.launcherWarning && !versionCheck) {
      process.env.PI_SKIP_VERSION_CHECK = '1'
      suppressed = true
    }
  })
  pi.registerCommand('pih', {
    description: 'Quit and reopen this saved chat in the installed harness',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui' || args.trim()) {
        ctx.ui.notify('Use /pih without arguments in the interactive editor.', 'info')
        return
      }

      const target = await targetFor(ctx, current())

      if (!target) {
        ctx.ui.notify('No saved chat needs a launcher change.', 'info')
        return
      }

      try {
        checkTarget(target)
      } catch {
        ctx.ui.notify(
          'Cannot verify the saved chat, project and launcher. Nothing was restarted.',
          'warning',
        )
        return
      }

      if (!process.execve || process.platform === 'win32') {
        ctx.ui.notify('Quit normally, then use the final harness resume command.', 'warning')
        return
      }

      if (
        requested ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        ctx.ui.getEditorText() ||
        busy()
      ) {
        ctx.ui.notify('Finish the current work and clear the editor before using /pih.', 'warning')
        return
      }

      requested = target
      ctx.shutdown()
    },
  })
  pi.on('session_shutdown', async (event, ctx) => {
    if (suppressed) {
      if (versionCheck === undefined) {
        delete process.env.PI_SKIP_VERSION_CHECK
      } else {
        process.env.PI_SKIP_VERSION_CHECK = versionCheck
      }

      suppressed = false
    }

    if (event.reason === 'quit' && ctx.mode === 'tui') {
      const target = requested ?? (await targetFor(ctx, current()))

      if (target) {
        finishQuit(target, Boolean(requested))
      }
    }

    requested = undefined
  })
}
