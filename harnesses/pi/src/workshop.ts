import { Type } from 'typebox'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { StateStore } from './state.ts'
import { textResult } from './file-tools.ts'
import { consultationInput, consultationSchema, DesignConsultations } from './design-advice.ts'

export function registerWorkshop(pi: ExtensionAPI) {
  let closed = false
  let current: ExtensionContext | undefined
  const consultations = new DesignConsultations(undefined, (count) => {
    if (!closed) {
      current?.ui.setStatus(
        'pi-design',
        count ? `Fable · ${count} active consultation${count === 1 ? '' : 's'}` : undefined,
      )
    }
  })
  const cancel = async (ctx: ExtensionContext) => {
    current = ctx
    await consultations.cancelAll()
    ctx.ui.setStatus('pi-design', undefined)
  }
  pi.on('session_shutdown', async (_event, ctx) => {
    closed = true
    ctx.ui.setStatus('pi-design', undefined)
    await consultations.close()
  })
  pi.on('session_before_tree', async (_event, ctx) => cancel(ctx))
  pi.on('session_before_fork', async (_event, ctx) => cancel(ctx))
  pi.registerTool({
    name: 'consult_design',
    label: 'Consult Fable on design',
    description:
      'Start independent Fable design advice in the background. Supply the same question and ' +
      'relevant document paths. Continue your own analysis; advice arrives as a follow-up.',
    parameters: consultationSchema,
    async execute(_id, args, signal, _update, ctx) {
      current = ctx
      const epoch = consultations.epoch
      const store = new StateStore(ctx.cwd)
      const session = ctx.sessionManager.getSessionId()
      const checkpoint = await store.checkpoint()
      const users = ctx.sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== 'message' || entry.message.role !== 'user') {
          return []
        }

        if (checkpoint && entry.message.timestamp < Date.parse(checkpoint.acceptedAt)) {
          return []
        }

        const content = entry.message.content
        return [
          typeof content === 'string'
            ? content
            : content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n'),
        ]
      })
      const input = await consultationInput(store, args, users)
      const job = await consultations.start(
        store,
        session,
        input,
        args.question,
        (result) => {
          if (closed || ctx.sessionManager.getSessionId() !== session) {
            return
          }

          pi.sendMessage(
            {
              customType: 'pi-design-advice',
              content:
                `Fable design consultation · ${result.status}\n` +
                `Model: ${result.advice?.model ?? 'claude-cli'}\n\n` +
                `Question: ${result.question}\n\n` +
                (result.status === 'complete' ? result.advice!.text : `Error: ${result.error}`),
              display: true,
              details: { consultationId: result.id },
            },
            { triggerTurn: true, deliverAs: 'followUp' },
          )
        },
        signal,
        epoch,
      )
      return textResult({
        ...job,
        next: 'Continue your own analysis; Fable will report automatically.',
      })
    },
  })
  pi.registerTool({
    name: 'design_consultation',
    label: 'Inspect Fable consultation',
    description: 'Read, await, or cancel a design consultation by ID. Prefer automatic delivery.',
    parameters: Type.Object({
      id: Type.String(),
      action: Type.Union([Type.Literal('status'), Type.Literal('wait'), Type.Literal('cancel')]),
    }),
    async execute(_id, args, signal, _update, ctx) {
      const store = new StateStore(ctx.cwd)
      const session = ctx.sessionManager.getSessionId()
      await consultations.get(store, session, args.id)

      if (args.action !== 'status') {
        await consultations.settle(args.id, args.action === 'cancel', signal)
      }

      const result = await consultations.get(store, session, args.id)

      return textResult(result)
    },
  })
  return { cancel }
}
