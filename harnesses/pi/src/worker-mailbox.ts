import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { acquireLock } from './lock.ts'
import { atomicJson, readJson } from './state.ts'

export type Guidance = {
  id: string
  text: string
  at: string
  status: 'pending' | 'queued' | 'delivered'
  deliveredAt?: string
}
type MailboxState = { accepting: boolean; messages: Guidance[] }

export function guidanceText(message: Guidance): string {
  return JSON.stringify({
    piWorkerGuidance: message.id,
    userGuidance: message.text,
    instruction: 'Apply this user guidance within your existing assignment and immutable scope.',
  })
}

/** Sending and final acceptance share a lock, so accepted guidance cannot miss completion. */
export class WorkerMailbox {
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await atomicJson(join(this.directory, 'mailbox.json'), { accepting: true, messages: [] })
  }

  async read(): Promise<MailboxState> {
    const state = await readJson<MailboxState>(join(this.directory, 'mailbox.json'))

    if (!state || !Array.isArray(state.messages)) {
      throw new Error('Worker guidance channel is unavailable')
    }

    return state
  }

  private async locked<T>(action: (state: MailboxState) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      let release

      try {
        release = await acquireLock(join(this.directory, 'mailbox.lock'))
      } catch (error) {
        if (!String(error).includes('already running') || attempt === 99) {
          throw error
        }

        await delay(20)
        continue
      }

      try {
        const state = await this.read()
        const result = await action(state)
        await atomicJson(join(this.directory, 'mailbox.json'), state)
        return result
      } finally {
        await release()
      }
    }

    throw new Error('Worker guidance channel is busy; try again')
  }

  async send(text: string): Promise<Guidance> {
    if (!text.trim() || text.length > 16000) {
      throw new Error('Guidance must contain 1–16000 characters')
    }

    return this.locked(async (state) => {
      if (!state.accepting) {
        throw new Error('This worker has finished accepting guidance; return to its coordinator')
      }

      const pending = state.messages.filter((message) => message.status !== 'delivered')

      if (pending.length >= 32) {
        throw new Error('32 messages await delivery; wait for the worker to receive them')
      }

      const message: Guidance = {
        id: randomUUID(),
        text,
        at: new Date().toISOString(),
        status: 'pending',
      }
      state.messages = [
        ...state.messages.filter((item) => item.status === 'delivered').slice(-100),
        ...pending,
        message,
      ]
      return message
    })
  }

  async queue(deliver: (message: Guidance) => Promise<void>): Promise<void> {
    if (!(await this.read()).messages.some((message) => message.status === 'pending')) {
      return
    }

    await this.locked(async (state) => {
      for (const message of state.messages.filter((item) => item.status === 'pending')) {
        await deliver(message)
        message.status = 'queued'
      }
    })
  }

  async acknowledge(id: string): Promise<void> {
    await this.locked(async (state) => {
      const message = state.messages.find((item) => item.id === id)

      if (message) {
        message.status = 'delivered'
        message.deliveredAt = new Date().toISOString()
      }
    })
  }

  async seal(): Promise<boolean> {
    return this.locked(async (state) => {
      if (state.messages.some((message) => message.status !== 'delivered')) {
        return false
      }

      state.accepting = false
      return true
    })
  }

  async toolBoundary<T>(submit: boolean, action: () => Promise<T>) {
    if (!submit) {
      const before = await this.take()

      if (before.length) {
        return { messages: before, blocked: true as const }
      }

      // Long tools stay outside the lock so guidance can arrive while they run.
      const result = await action()
      return { messages: await this.take(), blocked: false as const, result }
    }

    return this.locked(async (state) => {
      const messages = state.messages.filter((message) => message.status !== 'delivered')

      for (const message of messages) {
        message.status = 'delivered'
        message.deliveredAt = new Date().toISOString()
      }

      if (submit && messages.length) {
        return { messages, blocked: true as const }
      }

      const result = await action()

      if (submit) {
        state.accepting = false
      }

      return { messages, blocked: false as const, result }
    })
  }

  private async take(): Promise<Guidance[]> {
    if (!(await this.read()).messages.some((message) => message.status !== 'delivered')) {
      return []
    }

    return this.locked(async (state) => {
      const messages = state.messages.filter((message) => message.status !== 'delivered')

      for (const message of messages) {
        message.status = 'delivered'
        message.deliveredAt = new Date().toISOString()
      }

      return messages
    })
  }

  async stop(): Promise<void> {
    await this.locked(async (state) => {
      state.accepting = false
    })
  }
}
