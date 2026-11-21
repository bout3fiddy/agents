import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { textResult } from './file-tools.ts'

const retry = Type.Object(
  {
    blocker: Type.String({ minLength: 1, maxLength: 400, pattern: '\\S' }),
    resumeWhen: Type.String({ minLength: 1, maxLength: 400, pattern: '\\S' }),
  },
  { additionalProperties: false },
)

const parameters = Type.Object({
  state: Type.Union(['active', 'waiting', 'done', 'paused'].map((s) => Type.Literal(s))),
  retry: Type.Optional(retry),
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
      'source, paused for a stop, or done with verified completion evidence. At the first ' +
      'operational retry set retry.blocker and retry.resumeWhen for a visible update.',
    parameters,
    async execute(_id, input, _signal, _update, ctx) {
      const previous = latest(ctx)?.retry

      if (input.retry && input.state !== 'active' && input.state !== 'waiting') {
        throw new Error('Report retry conditions only on active or waiting work')
      }

      pi.appendEntry(recordType, { ...input, session: ctx.sessionManager.getSessionId() })

      if (
        input.retry &&
        (previous?.blocker !== input.retry.blocker ||
          previous.resumeWhen !== input.retry.resumeWhen)
      ) {
        pi.sendMessage(
          {
            customType: 'pi-host-work-blocker',
            display: true,
            content: input.retry.blocker + '\nResume condition · ' + input.retry.resumeWhen,
          },
          { triggerTurn: false },
        )
      }

      return textResult(input)
    },
  })
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted) {
      const work = latest(ctx)

      if (work?.state === 'active') {
        pi.appendEntry(recordType, { ...work, state: 'paused', retry: undefined })
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
          {
            type: 'custom',
            customType: recordType,
            data: { ...work, state: 'paused', retry: undefined },
          },
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
            {
              type: 'custom',
              customType: recordType,
              data: { ...work, state: 'paused', retry: undefined },
            },
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
