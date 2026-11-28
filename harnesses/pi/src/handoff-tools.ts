import { randomUUID } from 'node:crypto'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { DeliveryLedger, liveSession } from './delivery.ts'
import { structuredResult } from './file-tools.ts'
import { capturePiHost } from './pi-host.ts'
import { HandoffStore } from './handoff-store.ts'
import { installedReceiver, Receiver } from './handoff-receiver.ts'
import type { HandleRequest } from './handoff-session.ts'

export type HandoffOptions = {
  agentDir: string
  wrapper?: string
  handle?: HandleRequest
  tickMs?: number
}
const readyType = 'pi-project-result'
const outputSchema = Type.Object({}, { additionalProperties: true })

export function registerHandoffs(pi: ExtensionAPI, options?: HandoffOptions) {
  let receiver: Receiver | undefined
  let timer: NodeJS.Timeout | undefined
  const ledger = new DeliveryLedger()
  pi.on('tool_call', (event) => {
    if (
      ['project_list', 'project_send', 'project_status'].includes(event.toolName) &&
      !event.parentToolCallId
    ) {
      return { block: true, reason: 'Call project handoff tools in codemode.' }
    }

    return undefined
  })
  const current = () => {
    if (!receiver || receiver.mail.local(receiver.root)?.name !== receiver.name) {
      throw new Error('Use an enrolled project root in an installed pih session')
    }

    return receiver
  }
  pi.registerTool({
    name: 'project_list',
    label: 'Discover enrolled projects',
    outputSchema,
    description:
      'List project aliases and observed receiver liveness without opening a destination.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return structuredResult({ projects: current().mail.list() })
    },
  })
  pi.registerTool({
    name: 'project_send',
    label: 'Send one project request',
    outputSchema,
    description:
      'Send a minimal self-contained brief to an enrolled alias. Use discuss for advice; ' +
      'build only for local user-authorized implementation. Reuse the key for the identical send.',
    parameters: Type.Object(
      {
        destination: Type.String({ maxLength: 40 }),
        key: Type.String({ maxLength: 80 }),
        intent: Type.Union([Type.Literal('discuss'), Type.Literal('build')]),
        brief: Type.String({ minLength: 1, maxLength: 8000 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, _signal, _update, ctx) {
      const { mail, root } = current()
      const start = installedReceiver(mail.agentDir, options?.wrapper)
      const id = mail.send(
        root,
        ctx.sessionManager.getSessionId(),
        args.destination,
        args.key,
        args.intent,
        args.brief,
        start,
      )
      return structuredResult(mail.observe(root, id))
    },
  })
  pi.registerTool({
    name: 'project_status',
    label: 'Read project reply',
    outputSchema,
    description: 'Read one durable request from this source checkout. Never launches or retries.',
    parameters: Type.Object(
      { id: Type.String({ maxLength: 36 }) },
      { additionalProperties: false },
    ),
    async execute(_id, { id }) {
      const { mail, root } = current()
      return structuredResult(mail.observe(root, id))
    },
  })

  function notify(ctx: ExtensionContext, session: string, host: Receiver) {
    if (!ctx.isIdle()) {
      return
    }

    const rows = host.mail.recent(host.name, session)

    if (!rows.length) {
      return
    }

    const delivered = new Set(
      ctx.sessionManager
        .getEntries()
        .flatMap((e) =>
          e.type === 'custom_message' && e.customType === readyType
            ? [(e.details as { id: string }).id]
            : [],
        ),
    )
    const now = Date.now()

    for (const row of rows) {
      if (delivered.has(row.id)) {
        host.mail.acknowledge(host.name, session, row.id)
        ledger.acknowledge(row.id)
      }
    }

    const next = rows.find((r) => !delivered.has(r.id) && ledger.dueWhileIdle(r.id, now))

    if (next) {
      ledger.offer(next.id, now)
      pi.sendMessage(
        {
          customType: readyType,
          display: true,
          details: { id: next.id },
          content: `Project request ${next.id} settled. Use project_status and report its result.`,
        },
        { triggerTurn: true },
      )
    }
  }

  const detach = () => {
    const previous = receiver
    receiver = undefined
    return previous?.close().catch(() => {
      console.error(
        'Project receiver could not release its lease cleanly; it expires automatically.',
      )
    })
  }
  const close = () => {
    clearInterval(timer)
    return detach()
  }
  const connect = (root: string) => {
    const mail = HandoffStore.open(options?.agentDir)

    if (!mail) {
      return undefined
    }

    try {
      const p = mail.local(root)

      if (p) {
        return new Receiver(mail, p.root, p.name, randomUUID(), options?.handle)
      }

      mail.close()
      return undefined
    } catch (error) {
      mail.close()
      throw error
    }
  }
  pi.on('session_shutdown', close)
  pi.on('session_start', async (_event, ctx) => {
    await close()

    if (process.env.PI_HARNESS_WORKER || (!options && !capturePiHost().wrapper)) {
      return
    }

    const tick = () => {
      try {
        const session = liveSession(ctx)

        if (!session) {
          void close()
          return
        }

        // A user may enroll an already-open checkout without restarting or waking a model.
        receiver ??= connect(ctx.cwd)

        if (receiver) {
          if (!receiver.tick(false) && receiver.mail.local(ctx.cwd)?.name !== receiver.name) {
            void detach()
            return
          }

          notify(ctx, session, receiver)
        }
      } catch (error) {
        ctx.ui.notify(`Project handoff receiver stopped: ${String(error)}`, 'error')
        void close()
      }
    }
    timer = setInterval(tick, options?.tickMs ?? 1000)
    timer.unref()
    tick()
  })
}
