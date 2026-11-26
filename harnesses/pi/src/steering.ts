import { keyText, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { installPush } from './push-follow-up.ts'

function keys() {
  const followUp = keyText('app.message.followUp')
  return `Enter: steer · ${followUp}: follow up · ${followUp} on empty: push waiting`
}

export default function registerSteering(pi: ExtensionAPI): void {
  let uninstall: (() => void) | undefined
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      uninstall?.()
      uninstall = installPush(ctx)
    }
  })
  pi.on('session_shutdown', (_event, ctx) => {
    uninstall?.()
    uninstall = undefined

    if (ctx.mode === 'tui') {
      ctx.ui.setStatus('host-input', undefined)
    }
  })
  pi.registerCommand('steer', {
    description: 'Send human guidance at the next safe boundary, without cancelling work',
    async handler(args, ctx) {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /steer TEXT. ' + keys(), 'info')
        return
      }

      pi.sendUserMessage(args, { deliverAs: 'steer' })
    },
  })
  pi.on('agent_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      ctx.ui.setStatus('host-input', keys())
    }
  })
  pi.on('agent_end', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      ctx.ui.setStatus('host-input', undefined)
    }
  })
}
