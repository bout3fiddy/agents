import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { textResult } from './file-tools.ts'

const parameters = Type.Object({
  state: Type.Union(['active', 'waiting', 'done', 'paused'].map((s) => Type.Literal(s))),
  detail: Type.String({ minLength: 1, maxLength: 800 }),
})
const record = Type.Object({ ...parameters.properties, session: Type.String() })
const recordType = 'pi-host-work'
const followUp = 'pi-host-work-next'

function latest(ctx: ExtensionContext) {
  const id = ctx.sessionManager.getSessionId()
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (e) =>
        e.type === 'custom' &&
        e.customType === recordType &&
        Check(record, e.data) &&
        e.data.session === id,
    )
  return entry?.type === 'custom' && Check(record, entry.data) ? entry.data : undefined
}

export function registerHostWork(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'host_work',
    label: 'Track host work',
    description:
      'Keep authorized multi-step work moving on this host across status updates. ' +
      'Use active with the objective and next action. Use waiting with the dependency and wake ' +
      'source, paused for a stop, or done with verified completion evidence. Session-local.',
    parameters,
    async execute(_id, input, _signal, _update, ctx) {
      pi.appendEntry(recordType, { ...input, session: ctx.sessionManager.getSessionId() })
      return textResult(input)
    },
  })
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted) {
      const work = latest(ctx)

      if (work?.state === 'active') {
        pi.appendEntry(recordType, { ...work, state: 'paused' })
      }
    }
  })
  pi.on('before_agent_start', (_event, ctx) => {
    const work = latest(ctx)

    if (work && ['active', 'waiting'].includes(work.state)) {
      return {
        message: {
          customType: 'pi-host-work-context',
          display: false,
          content:
            'Host work in this conversation: ' +
            JSON.stringify(work) +
            '. Honor new user directions. Resume a waiting task only when its dependency clears.',
        },
      }
    }
  })

  pi.on('agent_before_settle', (event, ctx) => {
    const work = latest(ctx)

    if (work?.state !== 'active') {
      return
    }

    if (event.outcome !== 'completed') {
      return {
        entries: [
          ...event.entries,
          { type: 'custom', customType: recordType, data: { ...work, state: 'paused' } },
        ],
      }
    }

    if (event.continue || event.context.pendingMessages.length) {
      return
    }

    const messages = event.context.contextMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!

      if (m.role === 'user' || (m.role === 'toolResult' && m.toolName !== 'host_work')) {
        break
      }

      if (m.role === 'custom' && m.customType === followUp) {
        return {
          entries: [
            ...event.entries,
            { type: 'custom', customType: recordType, data: { ...work, state: 'paused' } },
            {
              type: 'custom_message',
              customType: 'pi-host-work-stalled',
              display: true,
              content: 'Host work paused after a continuation produced no action. ' + work.detail,
            },
          ],
        }
      }
    }

    return {
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: followUp,
          display: false,
          content:
            'The host still owns this authorized work: ' +
            work.detail +
            '. Take the next available action now. If complete, blocked, or stopped, ' +
            'record that state with host_work and explain the evidence. Honor newer user input.',
        },
      ],
      continue: true,
    }
  })
}
