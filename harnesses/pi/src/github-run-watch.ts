import { randomUUID } from 'node:crypto'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { githubApi, type GitHubCommand } from './branch-github.ts'
import { githubPrState } from './github-pr-state.ts'
import { textResult } from './file-tools.ts'
import { DeliveryLedger, deliveryLimits, type DeliveryLimits } from './delivery.ts'

const watchFields = Type.Object({
  repository: Type.String({
    pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$',
  }),
  runId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  pullRequest: Type.Optional(
    Type.Object({
      number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    }),
  ),
  followUp: Type.String({ minLength: 1, maxLength: 1000 }),
})
const parameters = Type.Object({
  ...watchFields.properties,
  action: Type.Optional(Type.Union([Type.Literal('watch'), Type.Literal('cancel')])),
  followUp: Type.Optional(watchFields.properties.followUp),
})
const registration = Type.Object({
  ...watchFields.properties,
  id: Type.String(),
  session: Type.String(),
})
const resultIds = Type.Array(Type.String())
const runSchema = Type.Object({
  id: Type.Integer(),
  status: Type.String(),
  conclusion: Type.Union([Type.String(), Type.Null()]),
  head_sha: Type.String({ pattern: '^[a-fA-F0-9]{40}$' }),
  run_attempt: Type.Integer({ minimum: 1 }),
  run_started_at: Type.Union([Type.String(), Type.Null()]),
  updated_at: Type.String(),
})
type Watch = Static<typeof registration>
type Pending = { watch: Watch; errors: number; result?: Static<typeof runSchema> | string }

/** What a registered watch currently is, for anything that waits on it. */
export type RunWatchState = { status: string; terminal: boolean }
export type RunWatches = {

  /** The latest watch this session registered for a run, on any branch of its tree. */
  find(ctx: ExtensionContext, repository: string, runId: number): string | undefined
  state(ctx: ExtensionContext, watch: string): RunWatchState | undefined

  /** Stop the local follow-up of one pending watch. GitHub continues running. */
  withdraw(watch: string): boolean
}

function resultStatus(result: Pending['result']): string {
  if (typeof result === 'string') {
    return result.slice(0, 120)
  }

  return result ? `${result.status}/${result.conclusion} at ${result.head_sha.slice(0, 12)}` : ''
}

export function registerGitHubRunWatch(
  pi: ExtensionAPI,
  run?: GitHubCommand,
  intervalMs = 30000,
  delivery: DeliveryLimits = deliveryLimits,
): RunWatches {
  let pending = new Map<string, Pending>()
  let controller = new AbortController()
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let offers = new DeliveryLedger(delivery)

  function stop() {
    clearInterval(timer)
    timer = undefined
    controller.abort()
    controller = new AbortController()
    pending = new Map()
    polling = false
    offers = new DeliveryLedger(delivery)
  }

  /** Watches whose result message is persisted in the session. Only that is delivery. */
  function acknowledge(ctx: ExtensionContext) {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === 'custom_message' &&
        entry.customType === 'pi-github-run-result' &&
        Check(resultIds, entry.details)
      ) {
        for (const id of entry.details) {
          if (offers.acknowledge(id)) {
            pending.delete(id)
          }
        }
      }
    }
  }

  async function inspect(item: Pending, signal: AbortSignal) {
    if (item.result) {
      return
    }

    const { repository, runId, pullRequest } = item.watch

    try {
      if (pullRequest) {
        const pr = await githubPrState(repository, pullRequest.number, signal, run)

        if (
          pr.state !== 'OPEN' ||
          pr.headRefOid !== pullRequest.expectedHead ||
          pr.mergeable === 'CONFLICTING'
        ) {
          item.result =
            'Pull request changed; recheck the current candidate before acting. ' +
            JSON.stringify(pr)
          return
        }
      }

      const data = await githubApi(`repos/${repository}/actions/runs/${runId}`, signal, { run })

      if (
        !Check(runSchema, data) ||
        data.id !== runId ||
        (data.status === 'completed' && !data.conclusion)
      ) {
        throw new Error('Invalid GitHub Actions run response')
      }

      if (pullRequest && data.head_sha !== pullRequest.expectedHead) {
        item.result = 'The watched run belongs to a different commit: ' + data.head_sha
        return
      }

      if (data.status === 'completed') {
        const { id, status, conclusion, head_sha, run_attempt, run_started_at, updated_at } = data
        item.result = { id, status, conclusion, head_sha, run_attempt, run_started_at, updated_at }
      }

      item.errors = 0
    } catch (error) {
      if (!signal.aborted && ++item.errors >= 3) {
        item.result = 'Run status unavailable after three checks. ' + String(error)
      }
    }
  }

  function schedule(ctx: ExtensionContext) {
    if (timer || !pending.size) {
      return
    }

    const signal = controller.signal
    const tick = async () => {
      if (polling || signal.aborted) {
        return
      }

      polling = true

      try {

        // A disposed SDK session can disappear without a shutdown event.
        try {
          if (!ctx.model) {
            return
          }
        } catch {
          stop()
          return
        }

        const items = [...pending.values()]
        await Promise.all(items.map((item) => inspect(item, signal)))

        if (signal.aborted) {
          return
        }

        acknowledge(ctx)
        const now = Date.now()

        if (offers.exhausted(now).length) {
          ctx.ui.notify(
            'A finished GitHub run watch could not wake this session. It stays recorded; ' +
              'reopen the session or ask for the run result.',
            'warning',
          )
        }

        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          return
        }

        // A sent wake is only an offer. The watch stays pending until its receipt is persisted,
        // and is offered again after a growing delay if the wake was dropped.
        const ready = items.filter(
          (item) =>
            item.result &&
            pending.get(item.watch.id) === item &&
            offers.dueWhileIdle(item.watch.id, now),
        )

        if (ready.length) {
          const results = ready.map(({ watch, result }) => ({
            repository: watch.repository,
            runId: watch.runId,
            ...(watch.pullRequest && { pullRequest: watch.pullRequest }),
            followUp: watch.followUp,
            result,
          }))
          pi.sendMessage(
            {
              customType: 'pi-github-run-result',
              display: false,
              details: ready.map((item) => item.watch.id),
              content:
                'GitHub Actions watch finished. Use the observed result to continue the ' +
                'authorized task now. Check the current head before acting.\n' +
                JSON.stringify(results),
            },
            { triggerTurn: true, deliverAs: 'followUp' },
          )

          for (const item of ready) {
            offers.offer(item.watch.id, now)
          }
        }

        if (!pending.size) {
          clearInterval(timer)
          timer = undefined
        }
      } finally {
        if (!signal.aborted) {
          polling = false
        }
      }
    }
    timer = setInterval(() => {
      void tick().catch((error: unknown) => {
        if (!signal.aborted) {
          try {
            ctx.ui.notify('GitHub run watch: ' + String(error), 'warning')
          } catch {
            stop()
          }
        }
      })
    }, intervalMs)
    timer.unref()
  }

  /**
   * Rebuild the watches from every entry of the session, in the order they were recorded. A watch
   * belongs to the session, not to the branch that registered it: navigating the tree must not
   * silently withdraw a follow-up, and a cancellation or receipt on any branch still counts.
   */
  function restore(ctx: ExtensionContext) {
    stop()
    const session = ctx.sessionManager.getSessionId()

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'pi-github-run-watch') {
        if (Check(registration, entry.data) && entry.data.session === session) {
          pending.set(entry.data.id, { watch: entry.data, errors: 0 })
        }
      } else if (entry.type === 'custom' && entry.customType === 'pi-github-run-unwatch') {
        if (Check(resultIds, entry.data)) {
          for (const id of entry.data) {
            pending.delete(id)
          }
        }
      } else if (entry.type === 'custom_message' && entry.customType === 'pi-github-run-result') {
        if (Check(resultIds, entry.details)) {
          for (const id of entry.details) {
            pending.delete(id)
          }
        }
      }
    }

    schedule(ctx)
  }

  pi.on('session_start', (_event, ctx) => restore(ctx))
  pi.on('session_shutdown', stop)
  pi.registerTool({
    name: 'watch_github_run',
    label: 'Watch GitHub Actions run',
    description:
      'Return immediately and wake this session when a run completes. Specify the next ' +
      'authorized action for success or failure. For a merge, include pullRequest with the ' +
      'reviewed head to wake on replacement, conflict or closure. Re-register to update. ' +
      'Use action=cancel to stop local follow-ups for a run; optionally limit to a pinned PR. ' +
      'GitHub continues running.',
    parameters,
    async execute(_call, input, _signal, _update, ctx) {
      const repository = input.repository.toLowerCase()

      if (input.action === 'cancel') {
        const ids = [...pending.values()]
          .filter(
            ({ watch }) =>
              watch.repository === repository &&
              watch.runId === input.runId &&
              (!input.pullRequest ||
                (input.pullRequest.number === watch.pullRequest?.number &&
                  input.pullRequest.expectedHead === watch.pullRequest.expectedHead)),
          )
          .map(({ watch }) => watch.id)

        if (ids.length) {
          pi.appendEntry('pi-github-run-unwatch', ids)

          for (const id of ids) {
            pending.delete(id)
            offers.acknowledge(id)
          }

          if (!pending.size) {
            stop()
          }
        }

        return textResult({ repository, runId: input.runId, cancelledWatches: ids.length })
      }

      if (!input.followUp) {
        throw new Error('Watching a CI run requires the next authorized followUp')
      }

      const existing = [...pending.values()].find(
        ({ watch }) =>
          watch.repository === repository &&
          watch.runId === input.runId &&
          watch.pullRequest?.number === input.pullRequest?.number,
      )
      const watch = {
        runId: input.runId,
        pullRequest: input.pullRequest,
        followUp: input.followUp,
        repository,
        id: existing?.watch.id ?? randomUUID(),
        session: ctx.sessionManager.getSessionId(),
      }
      pi.appendEntry('pi-github-run-watch', watch)

      if (existing) {
        if (existing.watch.pullRequest?.expectedHead !== watch.pullRequest?.expectedHead) {
          pending.set(watch.id, { watch, errors: 0 })
        } else {
          existing.watch = watch
        }
      } else {
        pending.set(watch.id, { watch, errors: 0 })
      }

      schedule(ctx)
      return textResult({ watching: watch.runId, repository, followUp: watch.followUp })
    },
  })

  return {
    find(ctx, repository, runId) {
      const session = ctx.sessionManager.getSessionId()
      const name = repository.toLowerCase()
      const entry = ctx.sessionManager
        .getEntries()
        .findLast(
          (item) =>
            item.type === 'custom' &&
            item.customType === 'pi-github-run-watch' &&
            Check(registration, item.data) &&
            item.data.session === session &&
            item.data.repository === name &&
            item.data.runId === runId,
        )
      return entry?.type === 'custom' && Check(registration, entry.data) ? entry.data.id : undefined
    },
    state(ctx, watch) {
      const item = pending.get(watch)

      if (item) {
        return item.result
          ? { status: resultStatus(item.result), terminal: true }
          : { status: 'pending', terminal: false }
      }

      // No longer pending: its result was delivered, or the watch was withdrawn.
      for (const entry of ctx.sessionManager.getEntries().toReversed()) {
        if (
          entry.type === 'custom_message' &&
          entry.customType === 'pi-github-run-result' &&
          Check(resultIds, entry.details) &&
          entry.details.includes(watch)
        ) {
          return { status: 'finished', terminal: true }
        }

        if (
          entry.type === 'custom' &&
          entry.customType === 'pi-github-run-unwatch' &&
          Check(resultIds, entry.data) &&
          entry.data.includes(watch)
        ) {
          return { status: 'withdrawn', terminal: true }
        }
      }

      return undefined
    },
    withdraw(watch) {
      if (!pending.has(watch)) {
        return false
      }

      pi.appendEntry('pi-github-run-unwatch', [watch])
      pending.delete(watch)
      offers.acknowledge(watch)

      if (!pending.size) {
        stop()
      }

      return true
    },
  }
}
