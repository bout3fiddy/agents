import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { InterruptInput } from './interrupt-input.ts'

export default function registerSteering(pi: ExtensionAPI): void {
  let interrupt: InterruptInput | undefined
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      interrupt?.uninstall()
      interrupt = new InterruptInput(ctx)
    }
  })
  pi.on('session_shutdown', () => {
    interrupt?.uninstall()
    interrupt = undefined
  })
  pi.registerCommand('steer', {
    description: 'Send human guidance at the next safe boundary, without cancelling work',
    async handler(args, ctx) {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /steer TEXT', 'info')
        return
      }

      const send = () => pi.sendUserMessage(args, { deliverAs: 'steer' })

      if (interrupt) {
        interrupt.steer(send)
      } else {
        send()
      }
    },
  })
}
