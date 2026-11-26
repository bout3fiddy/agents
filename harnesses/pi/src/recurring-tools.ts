import { replaceControlCharacters, stripTerminalSequences } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { RecurringTasks, scheduleName, scheduleSchema } from './recurring.ts'
import { StateStore } from './state.ts'
import { textResult } from './file-tools.ts'

export function registerRecurring(pi: ExtensionAPI, pollMs = 5000) {
  const open = (cwd: string) => new RecurringTasks(new StateStore(cwd))
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | undefined
  let lastError = ''

  pi.on('session_start', (_event, ctx) => {
    clearInterval(timer)
    const schedules = open(ctx.cwd)
    const observe = async () => {

      // The SDK can dispose a context without emitting session_shutdown.
      let model

      try {
        model = ctx.model
      } catch {
        clearInterval(observer)
        return
      }

      if (model) {
        const session = ctx.sessionManager.getSessionId()
        const notices = await schedules.tick(
          {
            session,
            model: `${model.provider}/${model.id}`,
          },
          () => ctx.sessionManager.getBranch(),
        )

        if (ctx.hasUI && ctx.sessionManager.getSessionId() === session) {
          for (const notice of notices) {
            const clean = replaceControlCharacters(stripTerminalSequences(notice))
            ctx.ui.notify(clean.replace(/\s+/g, ' ').slice(0, 800), 'info')
          }
        }
      }
    }
    const poll = () => {
      if (pending) {
        return
      }

      pending = observe()
        .then(() => {
          lastError = ''
        })
        .catch((error: unknown) => {
          if (String(error) !== lastError) {
            lastError = String(error)

            try {
              ctx.ui.notify(`Recurring task observer: ${lastError}`, 'warning')
            } catch {
              clearInterval(observer)
            }
          }
        })
        .finally(() => {
          pending = undefined
        })
    }
    const observer = setInterval(poll, pollMs)
    timer = observer
    observer.unref()
    poll()
  })
  pi.on('session_shutdown', async () => {
    clearInterval(timer)
    await pending
  })

  pi.registerTool({
    name: 'recurring_task',
    label: 'Manage recurring background tasks',
    description:
      'List, set (create or replace), or remove a named project schedule. ' +
      'Runs while Pi is open. For progress audits set work.kind=audit, model, thinking, ' +
      'reportDirectory and optional stopWhen. startImmediately runs the baseline. ' +
      'Use work.notifyEveryInterval for explicit periodic user updates, including quiet ticks. ' +
      'Set work.isolation to required when the scheduled work reads external or untrusted ' +
      'input; every occurrence then runs isolated. ' +
      'Other work uses normal scoped background delegation. Remove cancels outstanding work.',
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal('list'), Type.Literal('set'), Type.Literal('remove')]),
        name: Type.Optional(scheduleName),
        definition: Type.Optional(scheduleSchema),
        startImmediately: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, _signal, _update, ctx) {
      const schedules = open(ctx.cwd)

      if (args.action === 'list') {
        return textResult(await schedules.list())
      }

      if (!args.name) {
        throw new Error('Provide the schedule name')
      }

      if (args.action === 'remove') {
        return textResult(await schedules.remove(args.name))
      }

      if (!args.definition) {
        throw new Error('Provide the complete schedule definition')
      }

      return textResult(
        await schedules.set(
          args.name,
          args.definition,
          ctx.sessionManager.getSessionId(),
          args.startImmediately,
        ),
      )
    },
  })
}
