import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { capturePiHost, shellQuote } from './pi-host.ts'

// Pi 1.6.1 has no launcher-command option. Adapt only the command operands in its unbundled
// interactive UI, at module load. Keep Pi's persistence checks, warning triggers and rendering.
// Never rewrite terminal output, change APP_NAME (also used for settings), or edit node_modules.
function installUiAdapter(wrapper: string): void {
  const host = capturePiHost(wrapper)
  const target = pathToFileURL(join(dirname(host.entry), 'modes/interactive/interactive-mode.js'))
  const command = JSON.stringify(shellQuote(wrapper))
  const replacements = [
    ['const args = [APP_NAME];', `const args = [${command}];`],
    [
      'args.push("--session", sessionManager.getSessionId());',
      'args.push("--session", quoteIfNeeded(sessionFile));',
    ],
    ['`Restart ${APP_NAME}.`', '"Restart " + ' + command + ' + "."'],
    ['`${APP_NAME} update`', command + ' + " update"'],
    [
      '${APP_NAME} -r\\` to resume the session',
      '${formatResumeCommand(this.sessionManager) ?? ' + command + '}\\` to resume the session',
    ],
    ['"start pi and"', '"start " + ' + command + ' + " and"'],
    [
      'Restart ${APP_NAME} for this to take effect.',
      'Restart with ${formatResumeCommand(this.sessionManager) ?? ' +
        command +
        '} ' +
        'for this to take effect.',
    ],
  ] as const
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)

      if (url !== target.href) {
        return result
      }

      let source =
        typeof result.source === 'string'
          ? result.source
          : new TextDecoder().decode(result.source ?? undefined)

      for (const [before, after] of replacements) {
        const start = source.indexOf(before)

        if (start === -1 || start !== source.lastIndexOf(before)) {
          throw new Error('Pi interactive command format changed; verify the harness UI adapter.')
        }

        source = source.replace(before, () => after)
      }

      hooks.deregister()
      return { ...result, source }
    },
  })
}

// --import can be inherited by forked Node children. The marker is consumed only at launch.
const wrapper = process.env.PI_HARNESS_LAUNCH_WRAPPER

if (wrapper) {
  delete process.env.PI_HARNESS_LAUNCH_WRAPPER
  installUiAdapter(wrapper)
}
