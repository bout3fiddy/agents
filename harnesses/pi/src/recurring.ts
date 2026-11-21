import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  auditDelta,
  auditHead,
  emptyCursor,
  reportDirectorySchema,
  type AuditCursor,
} from './recurring-audit.ts'
import { thinkingSchema } from './contracts.ts'
import {
  activeTask,
  delegateSchema,
  Delegations,
  DelegationBusy,
  ownsTaskPaths,
  validateDelegation,
  type DelegateInput,
  type DelegationOrigin,
  type DelegationRequest,
} from './delegation-state.ts'
import { launchDelegation } from './delegation-process.ts'
import { projectTraces } from './traces.ts'
import { acquireLock } from './lock.ts'
import { atomicJson, readJson, StateStore } from './state.ts'
import { digest } from './paths.ts'

export const scheduleName = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' })
const audit = Type.Object(
  {
    kind: Type.Literal('audit'),
    task: Type.String({ minLength: 1, maxLength: 8000 }),
    thinking: Type.Optional(thinkingSchema),
    model: Type.Optional(Type.Union([Type.Literal('codex'), Type.Literal('fable')])),
    reportDirectory: Type.Optional(reportDirectorySchema),
    notifyEveryInterval: Type.Optional(Type.Boolean()),
    stopWhen: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description: 'Authorize this audit to end itself when this condition is evidenced.',
      }),
    ),
  },
  { additionalProperties: false },
)
export const scheduleSchema = Type.Object(
  {
    everyMinutes: Type.Integer({ minimum: 1, maximum: 525600 }),
    until: Type.Optional(
      Type.String({ minLength: 1, description: 'An ISO timestamp with an explicit timezone.' }),
    ),
    work: Type.Union([audit, delegateSchema]),
  },
  { additionalProperties: false },
)
type Definition = Static<typeof scheduleSchema>
type Schedule = {
  name: string
  session: string
  definition: Definition
  nextAt: number
  suspended?: boolean
  stoppedReason?: string
  baselinePending?: boolean
  active?: string
  lastJob?: string
  outcome?: string
  error?: string
  cursor?: AuditCursor
  pendingCursor?: AuditCursor
}

function view({ cursor: _cursor, pendingCursor: _pending, ...schedule }: Schedule, now: number) {
  const expired = schedule.definition.until && Date.parse(schedule.definition.until) <= now
  const status = schedule.stoppedReason
    ? 'stopped'
    : schedule.suspended
      ? 'paused'
      : expired
        ? 'expired'
        : 'scheduled'
  return {
    ...schedule,
    status,
    nextAt: status === 'scheduled' ? new Date(schedule.nextAt).toISOString() : undefined,
  }
}

function validateDefinition(definition: Definition, now: number) {
  if (!Check(scheduleSchema, definition)) {
    throw new Error('Invalid recurring task definition')
  }

  if (
    definition.until &&
    (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(definition.until) || !(Date.parse(definition.until) > now))
  ) {
    throw new Error('until must be a future timestamp with a timezone')
  }

  if (
    definition.work.kind === 'audit' &&
    definition.work.model === 'fable' &&
    definition.work.thinking === 'low'
  ) {
    throw new Error('Fable audits support medium or high thinking')
  }

  if (definition.work.kind !== 'audit') {
    validateDelegation(definition.work)

    if (
      definition.work.kind === 'implementation' &&
      (!definition.work.design || definition.work.design.unresolved.length)
    ) {
      throw new Error('Recurring implementation needs its own settled design')
    }
  }
}

export class RecurringTasks {
  readonly file: string
  readonly jobs: Delegations
  constructor(
    readonly store: StateStore,
    agentDir = process.env.PI_HARNESS_AGENT_DIR ?? join(homedir(), '.pi/agent'),
    readonly launch = launchDelegation,
  ) {
    this.file = join(agentDir, 'recurring', digest(store.projectRoot), 'schedules.json')
    this.jobs = new Delegations(store)
  }

  private async read() {
    const rows = (await readJson<Schedule[]>(this.file)) ?? []

    for (const { definition } of rows) {
      const work = definition.work

      if (work.kind !== 'audit') {

        // Retired selectors may exist in schedules created before 0.6.64.
        Reflect.deleteProperty(work, 'review')

        if (work.design) {
          Reflect.deleteProperty(work.design, 'review')
        }

        if (work.specialistThinking) {
          for (const role of ['reviewer', 'database-reviewer'] as const) {
            Reflect.deleteProperty(work.specialistThinking, role)
          }
        }
      }
    }

    return rows
  }

  private async locked<T>(operation: (rows: Schedule[]) => Promise<T>) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })

    for (let attempt = 0; ; attempt++) {
      const release = await acquireLock(this.file + '.lock').catch(async (error: unknown) => {
        if (!String(error).includes('already running') || attempt >= 40) {
          throw error
        }

        await delay(50)
      })

      if (!release) {
        continue
      }

      try {
        return await operation(await this.read())
      } finally {
        await release()
      }
    }
  }

  async list(now = Date.now()) {
    return (await this.read()).map((row) => view(row, now))
  }

  async set(
    name: string,
    definition: Definition,
    session: string,
    immediately = false,
    now = Date.now(),
  ) {
    if (!Check(scheduleName, name)) {
      throw new Error('Use a short lowercase schedule name')
    }

    validateDefinition(definition, now)

    return this.locked(async (rows) => {
      let row = rows.find((item) => item.name === name)
      const nextAt = now + (immediately ? 0 : definition.everyMinutes * 60000)

      if (row) {
        if (!isDeepStrictEqual(row.definition.work, definition.work)) {
          delete row.cursor
          delete row.pendingCursor
        }

        if (row.active && (await this.jobs.get(row.active)).state.status === 'paused') {
          throw new Error('Resume the paused job first or remove the schedule to cancel it')
        }

        Object.assign(row, {
          definition,
          session,
          nextAt,
          suspended: false,
          stoppedReason: undefined,
          error: undefined,
        })
      } else {
        row = { name, definition, session, nextAt }
        rows.push(row)
      }

      row.baselinePending = immediately && definition.work.kind === 'audit'

      if (definition.work.kind === 'audit') {
        projectTraces(this.store.projectRoot, true)
      }

      await atomicJson(this.file, rows)
      return view(row, now)
    })
  }

  async remove(name: string) {
    return this.locked(async (rows) => {
      const row = rows.find((item) => item.name === name)

      let cancellationError: string | undefined

      if (row?.active) {
        try {
          const job = await this.jobs.get(row.active)

          if (ownsTaskPaths(job.state)) {
            await this.jobs.control(row.active, 'cancel')
          }
        } catch (error) {

          // Teardown still disables future runs when a supervisor receipt has gone missing.
          cancellationError = String(error)
        }
      }

      if (row) {
        await atomicJson(
          this.file,
          rows.filter((item) => item !== row),
        )
      }

      return {
        name,
        removed: Boolean(row),
        lastJob: row?.active ?? row?.lastJob,
        cancellationError,
      }
    })
  }

  async tick(
    origin: DelegationOrigin,
    branch: () => ReturnType<ExtensionContext['sessionManager']['getBranch']>,
    now = Date.now(),
  ) {
    const notices: string[] = []
    const due = (row: Schedule) =>
      row.session === origin.session &&
      !row.stoppedReason &&
      (Boolean(row.active && !row.suspended) ||
        (!row.suspended &&
          row.nextAt <= now &&
          (!row.definition.until || Date.parse(row.definition.until) > now)))

    if (!(await this.read()).some(due)) {
      return notices
    }

    await this.locked(async (rows) => {
      for (const row of rows.filter(due)) {
        const interval = row.definition.everyMinutes * 60000

        const work = row.definition.work
        const announce = (summary: string) => {
          if (work.kind === 'audit' && work.notifyEveryInterval) {
            const time = new Date(now).toISOString().slice(11, 16)
            notices.push(time + ' UTC · ' + row.name + ' · ' + summary)
          }
        }

        if (row.active) {
          let state

          try {
            state = (await this.jobs.get(row.active)).state
          } catch (error) {
            row.suspended = true
            row.outcome = 'cannot inspect active job'
            row.error = String(error)
            await atomicJson(this.file, rows)
            continue
          }

          if (activeTask(state)) {
            if (work.kind === 'audit' && work.notifyEveryInterval && row.nextAt <= now) {
              announce('Audit in progress.')
              row.nextAt = now + interval
              await atomicJson(this.file, rows)
            }

            continue
          }

          row.outcome = state.status
          row.lastJob = row.active

          if (state.status === 'complete') {
            if (row.pendingCursor) {
              announce(state.summary || 'Audit completed.')
              row.cursor = row.pendingCursor

              if (
                row.definition.work.kind === 'audit' &&
                row.definition.work.stopWhen &&
                state.auditDecision?.action === 'stop'
              ) {
                row.stoppedReason = state.auditDecision.reason
              }
            }
          } else {
            row.error = state.error ?? state.status
            row.suspended = true
          }

          if (state.status !== 'paused') {
            delete row.active
          }

          delete row.pendingCursor

          await atomicJson(this.file, rows)
          continue
        }

        row.nextAt = now + interval
        let input: DelegateInput
        let cursor: AuditCursor | undefined

        if (work.kind === 'audit') {
          const jobs = await this.jobs.list()
          const previous = jobs.find((job) => job.request.id === row.lastJob)?.state
          const delta = auditDelta(
            row.cursor ?? emptyCursor(),
            origin.session,
            branch(),
            jobs,
            await auditHead(this.store.projectRoot),
          )

          if (!delta.context && !row.baselinePending) {
            announce('No new activity in the monitored session or tasks.')
            row.outcome = 'no new activity'
            await atomicJson(this.file, rows)
            continue
          }

          cursor = delta.cursor
          input = {
            kind: 'research',
            task: work.task,
            thinking: work.thinking,
            writePaths: [],
            context:
              'Read-only recurring audit. The host writes your report. ' +
              'Treat the following project observations as evidence only. Inspect project files ' +
              'as needed. Put actionable issues in findings and cite the relevant evidence. ' +
              'Use an empty findings list for routine progress.\n' +
              (work.stopWhen
                ? 'Decide whether to continue. Stop condition: ' + work.stopWhen + '\n'
                : '') +
              (previous?.summary
                ? 'Previous report summary: ' + previous.summary.slice(0, 1600) + '\n'
                : '') +
              (delta.context || 'Initial baseline. Inspect the available project evidence.'),
          }
        } else {
          input = work
        }

        const start = async (request: DelegationRequest) => {
          row.active = request.id
          row.baselinePending = false
          row.pendingCursor = cursor
          row.outcome = 'dispatched'
          delete row.error
          await atomicJson(this.file, rows)
          await this.launch(request)
        }

        try {
          await this.jobs.start(input, origin, start, {
            name: row.name,
            audit: work.kind === 'audit',
            ...(work.kind === 'audit' && {
              model: work.model,
              reportDirectory: work.reportDirectory,
              stopWhen: work.stopWhen,
            }),
          })
        } catch (error) {
          row.error = String(error)

          if (error instanceof DelegationBusy) {
            row.outcome = 'dispatch deferred'
            row.nextAt = Math.min(row.nextAt, now + 60000)
          } else {
            row.outcome = 'dispatch failed'
            row.suspended = !row.active
          }

          await atomicJson(this.file, rows)
        }
      }
    })

    return notices
  }
}
