import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { WorkersCatalog } from './workers-data.ts'
import { WorkersView } from './workers-ui.ts'

export function registerWorkers(pi: ExtensionAPI, window = { open: false }): void {
  const catalog = (ctx: ExtensionContext) =>
    new WorkersCatalog(
      ctx.cwd,
      (row, text) => {
        pi.sendMessage(
          {
            customType: 'pi-worker-guidance',
            display: false,
            content:
              `The user sent guidance directly to ${row.info.role} ${row.id}:\n${text}\n` +
              'Preserve this update in discussion. The selected worker receives it directly; ' +
              'do not restart or duplicate its work merely because this notice arrived.',
          },
          { deliverAs: 'nextTurn', triggerTurn: false },
        )
      },
      ctx.sessionManager.getSessionId(),
    )
  let closePanel: (() => void) | undefined
  const panel = (ctx: ExtensionContext) => {
    if (closePanel) {
      closePanel()
      closePanel = undefined
      return
    }

    const source = catalog(ctx)
    void ctx.ui
      .custom<void>(
        (tui, theme, _keys, done) => {
          closePanel = () => {
            closePanel = undefined
            done()
          }
          return new WorkersView(
            source,
            theme,
            () => Math.floor(tui.terminal.rows * 0.4),
            () => tui.requestRender(),
            closePanel,
            true,
          )
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: 'top-right',
            width: 40,
            maxHeight: '45%',
            margin: 1,
            nonCapturing: true,
            visible: (width) => width >= 120,
          },
        },
      )
      .catch((error: unknown) => {
        ctx.ui.notify(String(error), 'error')
      })
  }

  pi.registerCommand('workers', {
    description: 'Browse live subagents and send guidance; /workers panel toggles the side panel',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(
          '/workers requires an interactive terminal. Use job_status otherwise.',
          'info',
        )
        return
      }

      if (args.trim() === 'panel') {
        panel(ctx)
        return
      }

      if (window.open) {
        return
      }

      window.open = true

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) =>
            new WorkersView(
              catalog(ctx),
              theme,
              () =>
                Math.max(6, Math.min(tui.terminal.rows - 4, Math.floor(tui.terminal.rows * 0.94))),
              () => tui.requestRender(),
              () => done(),
            ),
          { overlay: true, overlayOptions: { width: '94%', maxHeight: '94%', margin: 1 } },
        )
      } finally {
        window.open = false
      }
    },
  })
  pi.on('session_shutdown', () => {
    closePanel?.()
    closePanel = undefined
  })
}
