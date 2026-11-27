import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { AssignmentStore, type Assignment } from '../src/assignments.ts'
import { Delegations, delegationDirectory, type TaskControls } from '../src/delegation-state.ts'
import type { DeliveryLimits } from '../src/delivery.ts'
import { StateStore, atomicJson, readJson } from '../src/state.ts'
import type { captureSession } from './session-support.ts'

export type Session = Awaited<ReturnType<typeof captureSession>>['session']
export type Reply = AssistantMessage['content']

/** Fast timing for tests: the same bounded backoff as production, on a millisecond scale. */
export const fastDelivery: DeliveryLimits = {
  attempts: 5,
  retryMs: 60,
  maxRetryMs: 2000,
  capacity: 64,
}
export const fastTick = 15

/** Faults injected where the feed hands a wake to the SDK. */
export type Faults = { drop: number; duplicate: number; dropped: number; duplicated: number }

export function noFaults(): Faults {
  return { drop: 0, duplicate: 0, dropped: 0, duplicated: 0 }
}

/**
 * The extension API with a faulty wake channel. A dropped wake is swallowed exactly as the SDK
 * swallows a run that fails to start; a duplicated one arrives a second time shortly after.
 */
export function faultyWakes(pi: ExtensionAPI, faults: Faults): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'sendMessage') {
        return Reflect.get(target, property, receiver) as unknown
      }

      const send: ExtensionAPI['sendMessage'] = (message, options) => {
        if (message.customType === 'pi-task-result' && options?.triggerTurn) {
          if (faults.drop > 0) {
            faults.drop--
            faults.dropped++
            return
          }

          if (faults.duplicate > 0) {
            faults.duplicate--
            faults.duplicated++
            setTimeout(() => target.sendMessage(message, options), 40)
          }
        }

        target.sendMessage(message, options)
      }
      return send
    },
  })
}

export function plain(message: Context['messages'][number] | undefined): string {
  const content = message?.content

  if (typeof content === 'string') {
    return content
  }

  return (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

export const say = (text: string): Reply => [{ type: 'text', text }]

export type Arguments = Extract<Reply[number], { type: 'toolCall' }>['arguments']
let calls = 0

export function call(name: string, args: Arguments): Reply[number] {
  calls++
  return { type: 'toolCall', id: `call-${calls}`, name, arguments: args }
}

/** The ID a dispatch tool returned for the task whose text starts with name. */
export function dispatched(context: Context, name: string): string {
  for (const message of context.messages.toReversed()) {
    if (message.role === 'toolResult' && message.toolName === 'delegate_task') {
      const text = plain(message)

      if (!message.isError && text.includes(`"task":"${name}`)) {
        return (JSON.parse(text) as { id: string }).id
      }
    }
  }

  throw new Error('No dispatch result for ' + name)
}

/** What an outcome message says about each bound task: its assignment and reported state. */
export function boundOutcomes(text: string): { assignment: string; task: string; state: string }[] {
  const bindings = /recorded assignments: (\[.*?\])\. Continue/s.exec(text)?.[1]
  const views = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as {
    id: string
    state: string
  }[]
  return (JSON.parse(bindings ?? '[]') as { assignment: string; task: string }[]).map(
    (binding) => ({
      ...binding,
      state: views.find((view) => view.id === binding.task)?.state ?? 'unknown',
    }),
  )
}

/** The active assignments a continuation names, with the source status it reports. */
export function continued(text: string): { assignment: string; state: string }[] {
  return text.split('\n').flatMap((line) => {
    const id = /^(a\d+) \[active/.exec(line)?.[1]
    const state = /Sources finished: .*? (\w+)(?: ·|$)/.exec(line)?.[1]
    return id ? [{ assignment: id, state: state ?? 'active' }] : []
  })
}

export type Step = (context: Context) => Reply

/** The messages that arrived since the host last spoke: a prompt or wake plus injected context. */
function arrivals(context: Context): string[] {
  const spoken = context.messages.findLastIndex((message) => message.role === 'assistant')
  return context.messages.slice(spoken + 1).map((message) => plain(message))
}

/** The arrived message containing phrase, if any. */
export function arrived(texts: string[], phrase: string): string | undefined {
  return texts.find((text) => text.includes(phrase))
}

/**
 * A scripted host. It reacts only to what the runtime puts in front of it: the messages that
 * arrived since it last spoke and its own tool results. Each reaction is a short plan of steps.
 */
export class ScriptedHost {
  readonly plan: Step[] = []

  /** The messages that arrived before every model request, as the runtime presented them. */
  readonly requests: string[][] = []
  readonly actions: { name: string; args: Arguments }[] = []
  readonly errors: unknown[] = []

  /** Assignments this host already closed; it does not act on them again. */
  readonly closed = new Set<string>()

  constructor(
    private readonly react: (host: ScriptedHost, texts: string[]) => Step[] | undefined,
  ) {}

  respond = async (context: Context): Promise<Reply> => {
    try {
      const last = context.messages.at(-1)
      const texts = arrivals(context)
      this.requests.push(texts)

      for (const message of context.messages) {
        if (message.role === 'toolResult' && message.toolName === 'host_work' && !message.isError) {
          const result = JSON.parse(plain(message)) as { assignment: string; state: string }

          if (result.state === 'done' || result.state === 'cancelled') {
            this.closed.add(result.assignment)
          }
        }
      }

      if (!this.plan.length && last?.role !== 'toolResult') {
        this.plan.push(...(this.react(this, texts) ?? []))
      }

      const reply = this.plan.shift()?.(context) ?? say('Noted.')

      for (const part of reply) {
        if (part.type === 'toolCall') {
          this.actions.push({ name: part.name, args: part.arguments })
        }
      }

      return reply
    } catch (error) {
      this.errors.push(error)
      throw error
    }
  }

  count(name: string, matches: (args: Arguments) => boolean = () => true) {
    return this.actions.filter((action) => action.name === name && matches(action.args)).length
  }

  /** How many requests were opened by one arrived message containing every phrase. */
  shown(...phrases: string[]) {
    return this.requests.filter((texts) =>
      texts.some((text) => phrases.every((phrase) => text.includes(phrase))),
    ).length
  }
}

export async function until(check: () => Promise<boolean> | boolean, label: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) {
      return
    }

    await delay(10)
  }

  assert.fail('Timed out waiting for ' + label)
}

/** Wait until the session has stopped and stays stopped past a late duplicate. */
export async function quiet(session: Session) {
  await session.waitForIdle()
  await delay(80)
  await session.waitForIdle()
}

/** The records as stored, read independently of the session that wrote them. */
export async function records(root: string, session: Session): Promise<Assignment[]> {
  const store = new AssignmentStore(
    new StateStore(root).directory,
    session.sessionManager.getSessionId(),
  )
  return (await store.read()).records
}

export async function record(root: string, session: Session, id: string): Promise<Assignment> {
  const found = (await records(root, session)).find((item) => item.id === id)
  assert.ok(found, 'assignment ' + id + ' is recorded')
  return found
}

export const registry = (root: string) => new Delegations(new StateStore(root))

/** The ID of the registered task whose text starts with name. */
export async function taskNamed(jobs: Delegations, name: string): Promise<string> {
  const job = (await jobs.list()).find((item) => item.request.task.startsWith(name))
  assert.ok(job, 'task ' + name + ' is registered')
  return job.request.id
}

/** Let the worker of a task end, as its supervisor would record it. */
export async function finish(
  jobs: Delegations,
  id: string,
  status: 'complete' | 'failed',
  summary: string,
) {
  const path = join(delegationDirectory(jobs.store, id), 'status.json')
  const state = await readJson<Record<string, unknown>>(path)
  assert.ok(state, 'task ' + id + ' has a status')
  await atomicJson(path, { ...state, status, summary, updatedAt: new Date().toISOString() })
}

export async function controls(jobs: Delegations, id: string): Promise<TaskControls> {
  const found = await readJson<TaskControls>(
    join(delegationDirectory(jobs.store, id), 'controls.json'),
  )
  assert.ok(found, 'task ' + id + ' has controls')
  return found
}

/** How often the outcome of a task was persisted in the session. */
export function receipts(session: Session, id: string): number {
  return session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === 'custom_message' &&
        entry.customType === 'pi-task-result' &&
        (entry.details as { taskIds: string[] }).taskIds.some((item) => item.startsWith(id)),
    ).length
}

/** Point the cross-checkout origin index at a private directory for one test. */
export function privateAgentDirectory(t: { after(cleanup: () => void): void }, directory: string) {
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = directory
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_HARNESS_AGENT_DIR
    } else {
      process.env.PI_HARNESS_AGENT_DIR = previous
    }
  })
}
