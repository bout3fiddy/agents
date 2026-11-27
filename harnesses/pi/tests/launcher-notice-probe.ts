import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// Exercise the pinned UI's real install-change detector and update renderer without a network
// check or touching the live dependency tree. PI_PACKAGE_DIR here is the fixture's private copy.
export default function noticeProbe(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    const copy = join(ctx.cwd, '../global')

    if (process.env.PI_PACKAGE_DIR !== copy) {
      throw new Error('Expected disposable package metadata for the launcher probe')
    }

    writeFileSync(join(copy, 'package.json'), JSON.stringify({ version: 'fixture-next' }))
    const { InteractiveMode } = createRequire(process.argv[1]!)(
      './modes/interactive/interactive-mode.js',
    )
    const notices: string[] = []
    const output = {
      sessionManager: ctx.sessionManager,
      showWarning: (message: string) => notices.push(message),
      ui: { requestRender() {} },
      chatContainer: {
        addChild(component: { render: (width: number) => string[] }) {
          notices.push(...component.render(512))
        },
      },
    }
    InteractiveMode.prototype.maybeShowInstallChangeWarning.call(output)
    InteractiveMode.prototype.showNewVersionNotification.call(output, { version: 'fixture-new' })
    writeFileSync(join(ctx.cwd, 'notices.txt'), notices.join('\n'))
    ctx.shutdown()
  })
}
