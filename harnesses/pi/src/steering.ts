import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { installPush } from './push-follow-up.ts'

export default function registerSteering(pi: ExtensionAPI): void {
  let uninstall: (() => void) | undefined
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      uninstall?.()
      uninstall = installPush(ctx)
    }
  })
  pi.on('session_shutdown', () => {
    uninstall?.()
    uninstall = undefined
  })
  pi.registerCommand('steer', {
    description: 'Send human guidance at the next safe boundary, without cancelling work',
    async handler(args, ctx) {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /steer TEXT', 'info')
        return
      }

      pi.sendUserMessage(args, { deliverAs: 'steer' })
    },
  })
}
