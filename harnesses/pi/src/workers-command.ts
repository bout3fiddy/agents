import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { WorkersCatalog } from './workers-data.ts'
import { WorkersView } from './workers-ui.ts'

export function registerWorkers(pi: ExtensionAPI): void {
  const catalog = (cwd: string) =>
    new WorkersCatalog(cwd, (row, text) => {
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
    })
  let opened = false
  let closePanel: (() => void) | undefined
  const panel = (ctx: ExtensionContext) => {
    if (closePanel) {
      closePanel()
      closePanel = undefined
      return
    }

    const source = catalog(ctx.cwd)
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
          '/workers requires an interactive terminal. Use task_status otherwise.',
          'info',
        )
        return
      }

      if (args.trim() === 'panel') {
        panel(ctx)
        return
      }

      if (opened) {
        return
      }

      opened = true

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) =>
            new WorkersView(
              catalog(ctx.cwd),
              theme,
              () => Math.max(6, tui.terminal.rows - 4),
              () => tui.requestRender(),
              () => done(),
            ),
          { overlay: true, overlayOptions: { width: '94%', maxHeight: '94%', margin: 1 } },
        )
      } finally {
        opened = false
      }
    },
  })
  pi.on('session_shutdown', () => {
    closePanel?.()
    closePanel = undefined
  })
}
