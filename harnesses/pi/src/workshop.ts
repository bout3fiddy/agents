import { Type } from 'typebox'
import { join } from 'node:path'
import type {
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { StateStore } from './state.ts'
import { textResult } from './file-tools.ts'
import {
  consultationInput,
  consultationSchema,
  DesignConsultations,
  type Consultation,
  type AdviceRunner,
} from './design-advice.ts'

function requestId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
}

function adviceMessage(result: Consultation): CustomMessageEntryDraft {
  return {
    type: 'custom_message',
    customType: 'pi-design-advice',
    content:
      `Fable design consultation · ${result.status}\n` +
      `Model: ${result.advice?.model ?? 'claude-cli'}\n\n` +
      `Question: ${result.question}\n\n` +
      (result.status === 'complete' ? result.advice!.text : `Error: ${result.error}`),
    display: true,
    details: { consultationId: result.id },
  }
}

export function registerWorkshop(pi: ExtensionAPI, runner?: AdviceRunner) {
  let closed = false
  let current: ExtensionContext | undefined
  let revision = 0
  const revisions = new Map<string, number>()
  pi.on('input', () => {
    revision++
  })
  const consultations = new DesignConsultations(runner, (count) => {
    if (!closed) {
      current?.ui.setStatus(
        'pi-design',
        count ? `Fable · ${count} active consultation${count === 1 ? '' : 's'}` : undefined,
      )
    }
  })
  const collect = async (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId()
    const store = new StateStore(ctx.cwd)
    const messages: CustomMessageEntryDraft[] = []
    const epoch = consultations.epoch
    const inputRevision = revision

    for (const ready of consultations.available(session)) {
      const currentRequest = () =>
        ready.requestId === requestId(ctx) &&
        revisions.get(ready.id) === revision &&
        !ctx.hasPendingMessages()
      const stale = !currentRequest()

      try {
        const result = await consultations.claim(
          store,
          session,
          ready.id,
          stale ? 'superseded' : 'automatic',
          {
            valid: () => !closed && epoch === consultations.epoch && (stale || currentRequest()),
          },
        )

        if (result) {
          revisions.delete(ready.id)

          if (!stale && !closed && epoch === consultations.epoch) {
            messages.push(adviceMessage(result))
          }
        }
      } catch (error) {
        consultations.suppress(ready.id)
        revisions.delete(ready.id)
        ctx.ui.notify(
          `Advice delivery failed; inspect its saved trace: ${String(error)}`,
          'warning',
        )
      }
    }

    if (
      closed ||
      epoch !== consultations.epoch ||
      revision !== inputRevision ||
      ctx.hasPendingMessages()
    ) {
      for (const message of messages) {
        const id = (message.details as { consultationId: string }).consultationId
        await consultations.discard(store, session, id).catch(() => {})
      }

      return []
    }

    return messages
  }
  const deliverIdle = async (ctx: ExtensionContext) => {
    if (closed || !ctx.isIdle() || ctx.hasPendingMessages()) {
      return
    }

    for (const message of await collect(ctx)) {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: 'steer' })
    }
  }
  const deliverBoundary = async (event: BoundaryState, ctx: ExtensionContext) => {
    if (closed || event.outcome !== 'completed' || event.context.pendingMessages.length) {
      return
    }

    const messages = await collect(ctx)

    if (messages.length) {
      return { entries: [...event.entries, ...messages], continue: true }
    }

    return undefined
  }
  pi.on('turn_end', deliverBoundary)
  pi.on('agent_before_settle', deliverBoundary)
  pi.on('agent_settled', async (_event, ctx) => deliverIdle(ctx))
  const cancel = async (ctx: ExtensionContext) => {
    current = ctx
    await consultations.cancelAll()
    revisions.clear()
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
      'Consult Fable for a material new decision, conflict, feasibility question or explicit ' +
      'second opinion. Routine choices and document edits reuse existing advice. Supply the ' +
      'user question, confirmed constraints and small document excerpts. Advice arrives between ' +
      'model steps; default 350 words. Continue your own analysis.',
    parameters: consultationSchema,
    async execute(_id, args, signal, _update, ctx) {
      current = ctx
      const epoch = consultations.epoch
      const inputRevision = revision
      const store = new StateStore(ctx.cwd)
      const session = ctx.sessionManager.getSessionId()
      const users = ctx.sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== 'message' || entry.message.role !== 'user') {
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
      const input = await consultationInput(store, args, users, requestId(ctx))

      if (inputRevision !== revision) {
        throw new Error(
          'User input changed during consultation preparation; use the latest question',
        )
      }

      const job = await consultations.start(
        store,
        session,
        input,
        args.question,
        async (result) => {
          if (closed || ctx.sessionManager.getSessionId() !== session) {
            return
          }

          if (result.error === 'Could not persist the consultation result') {
            ctx.ui.notify(result.error, 'warning')
          }

          await deliverIdle(ctx)
        },
        signal,
        epoch,
        args.thinking,
      )
      revisions.set(job.id, inputRevision)
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
      const before = await consultations.get(store, session, args.id)
      const inputRevision = revision
      const epoch = consultations.epoch
      const valid = () =>
        before.requestId === requestId(ctx) &&
        revision === inputRevision &&
        epoch === consultations.epoch &&
        !closed

      if (args.action === 'wait' && !valid()) {
        await consultations.settle(args.id, true)
        await consultations.claim(store, session, args.id, 'superseded')
      }

      if (args.action !== 'status') {
        await consultations.settle(args.id, args.action === 'cancel', signal)
      }

      if (args.action === 'wait') {
        const claimed = await consultations.claim(store, session, args.id, 'tool', {
          valid,
          signal,
        })

        if (claimed) {
          return textResult(claimed)
        }
      }

      if (args.action === 'cancel') {
        await consultations.claim(store, session, args.id, 'cancelled')
      }

      const { advice, ...status } = await consultations.get(store, session, args.id)
      const discarded =
        status.delivery?.via === 'cancelled' || status.delivery?.via === 'superseded'
      return textResult({
        ...status,
        model: advice?.model,
        tracePath: join(store.directory, 'consultations', `${args.id}.json`),
        next: discarded
          ? 'Automatic delivery suppressed; raw advice is retained in the trace.'
          : status.delivery
            ? 'Advice already consumed; use existing conversation context.'
            : 'Continue your own analysis; advice will arrive at the next safe boundary.',
      })
    },
  })
  return { cancel, consultations }
}
