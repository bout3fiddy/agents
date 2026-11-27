import { needsRestart, type PiInstall } from './pi-host.ts'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { captureBuild, readInstall, recoveryStatus, type LoadedRuntime } from './runtime-version.ts'

const command = 'harness-apply-install'
type ReloadTarget = Pick<PiInstall, 'sourceHash' | 'installedAt'> & { pid: number }

export function registerAutoReload(
  pi: ExtensionAPI,
  current: () => LoadedRuntime | undefined,
  busy: () => boolean,
): void {
  let timer: ReturnType<typeof setInterval> | undefined
  let removeInput: (() => void) | undefined
  let session: ExtensionContext | undefined
  let quietAfter = 0
  let checking = false
  let attempted = ''
  let pending: PiInstall | undefined
  const ready = (ctx: ExtensionContext) =>
    Date.now() >= quietAfter &&
    ctx.isIdle() &&
    !ctx.hasPendingMessages() &&
    !busy() &&
    !ctx.ui.getEditorText()

  pi.registerCommand(command, {
    description: 'Apply a pending local harness install when the host is idle',
    async handler(_args, ctx) {
      const install = pending
      pending = undefined

      if (!install || !session || !ready(ctx)) {
        return
      }

      const latest = await readInstall()

      if (latest?.installedAt !== install.installedAt || !session || !ready(ctx)) {
        return
      }

      attempted = install.installedAt

      if (captureBuild(install.source).sourceHash !== install.sourceHash) {
        ctx.ui.notify(
          'Harness source differs from the installed build. Run sync-pi to refresh.',
          'warning',
        )
        return
      }

      // Retain the target across extension replacement and verify the new generation on startup.
      pi.appendEntry('pi-auto-reload', {
        pid: process.pid,
        sourceHash: install.sourceHash,
        installedAt: install.installedAt,
      })
      await ctx.reload()
    },
  })

  const check = async (ctx: ExtensionContext) => {
    if (checking || !ready(ctx)) {
      return
    }

    checking = true

    try {
      const install = await readInstall()
      const loaded = current()

      if (
        !install ||
        !loaded ||
        ctx !== session ||
        install.installedAt === attempted ||
        !ready(ctx)
      ) {
        return
      }

      if (needsRestart(loaded.source, loaded.piHost, install)) {
        attempted = install.installedAt

        ctx.ui.setStatus('pi-harness', recoveryStatus(ctx, Boolean(loaded.piHost.wrapper)))

        return
      }

      if (install.sourceHash === loaded.sourceHash) {
        return
      }

      pending = install

      // With expansion enabled Pi dispatches this registered command before starting a model turn.
      pi.sendUserMessage('/' + command, { expandPromptTemplates: true })
    } finally {
      checking = false
    }
  }

  pi.on('session_start', (event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }

    session = ctx
    const previous = ctx.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === 'custom' &&
          (entry.customType === 'pi-auto-reload' || entry.customType === 'pi-harness-load'),
      )
      .at(-2)

    if (
      previous?.type === 'custom' &&
      previous.customType === 'pi-auto-reload' &&
      event.reason === 'reload'
    ) {
      const target = previous.data as ReloadTarget

      if (target?.pid === process.pid) {
        attempted = target.installedAt

        if (target.sourceHash !== current()?.sourceHash) {
          ctx.ui.notify(
            'Harness reload loaded a different build; check /harness-version.',
            'warning',
          )
        }
      }
    }

    removeInput = ctx.ui.onTerminalInput(() => {
      quietAfter = Date.now() + 1000
      return undefined
    })
    let warned = false
    timer = setInterval(() => {
      void check(ctx).catch(() => {
        if (!warned && session === ctx) {
          warned = true
          ctx.ui.notify(
            'Could not check the local harness install for automatic reload.',
            'warning',
          )
        }
      })
    }, 3000)
    timer.unref()
  })
  pi.on('session_shutdown', () => {
    clearInterval(timer)
    removeInput?.()
    session = undefined
    pending = undefined
  })
}
