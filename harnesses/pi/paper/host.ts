import { randomUUID } from 'node:crypto'
import { Design, validTarget, type Target } from './design.ts'
import { privateRoot, sameOwner, snapshot, WriterLease, type Owner } from './private.ts'
import { desktop, fail, limits, reason, Wire, type Failure, type Launch } from './protocol.ts'
import { descriptors } from './surface.ts'

export type { Owner, Snapshot } from './private.ts'
export type { Target } from './design.ts'
export type { Failure } from './protocol.ts'

export interface Attach {
  purpose: 'frontend-design'
  owner: Owner
  target: Target
  ttlMs: number
  draftTargetingVerified: boolean
}

type Result<T> = { outcome: 'ok'; value: T } | { outcome: Failure }

type Grant = {
  owner: Owner
  target: Target
  root: string
  id: string
  until: number
  lease: WriterLease
  wire?: Wire
  design?: Design
  timer?: NodeJS.Timeout
  stopped?: Failure
  closing?: Promise<Failure | undefined>
  ready: boolean
  busy: boolean
  operations: number
  errors: number
  snapshots: number
}

/** One slot per task. All host processes share the same private directory. */
export class PaperHost {
  private readonly directory: string
  private readonly launch: Launch
  private active?: Grant

  constructor(directory: string, launch: Launch = desktop) {
    this.directory = directory
    this.launch = launch
  }

  private check(grant: Grant) {
    if (grant.stopped) {
      fail(grant.stopped)
    }

    if (performance.now() >= grant.until) {
      this.close(grant, 'expired')
      fail('expired')
    }
  }

  private terminated(grant: Grant, failure: Failure) {
    grant.stopped ??= failure
    clearTimeout(grant.timer)
    grant.closing ??= this.release(grant)
    return grant.closing
  }

  private close(grant: Grant, failure: Failure) {
    grant.wire?.stop(failure)
    return this.terminated(grant, failure)
  }

  private async release(grant: Grant): Promise<Failure | undefined> {
    let timer: NodeJS.Timeout | undefined

    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('close timeout')), limits.timeoutMs)
      })
      await Promise.race([grant.wire?.closed, deadline])
      grant.lease.release()

      if (this.active === grant) {
        this.active = undefined
      }

      return undefined
    } catch {

      // A CLI that has not exited or a damaged lock requires host inspection. Do not unlock it.
      grant.stopped = 'storage'
      return 'storage'
    } finally {
      clearTimeout(timer)
    }
  }

  private start(input: Attach): Grant {
    if (input.purpose !== 'frontend-design') {
      fail('denied')
    }

    if (this.active) {
      fail('busy')
    }

    if (!validTarget(input.target) || typeof input.draftTargetingVerified !== 'boolean') {
      fail('invalid')
    }

    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > limits.lifetimeMs) {
      fail('invalid')
    }

    const root = privateRoot(this.directory, input.owner)
    const grant: Grant = {
      id: randomUUID(),
      owner: {
        sessionId: input.owner.sessionId,
        taskId: input.owner.taskId,
        worktree: input.owner.worktree,
      },
      target: {
        fileId: input.target.fileId,
        pageId: input.target.pageId,
        nodeIds: [...input.target.nodeIds],
      },
      until: performance.now() + input.ttlMs,
      root,
      lease: new WriterLease(root),
      ready: false,
      busy: false,
      operations: 0,
      errors: 0,
      snapshots: 0,
    }
    this.active = grant
    grant.timer = setTimeout(() => this.close(grant, 'expired'), input.ttlMs)
    grant.timer.unref()
    return grant
  }

  private save(grant: Grant, contents: unknown) {
    this.check(grant)

    if (++grant.snapshots > limits.snapshots) {
      fail('limit')
    }

    return snapshot(grant.root, {
      version: 1,
      attachmentId: grant.id,
      owner: grant.owner,
      target: grant.target,
      untrusted: true,
      contents,
    })
  }

  async attach(input: Attach) {
    let grant: Grant

    try {
      grant = this.start(input)
    } catch (error) {
      return { outcome: reason(error) } as const
    }

    try {
      grant.wire = new Wire(this.launch, (failure) => this.terminated(grant, failure))
      grant.design = new Design(grant.target, grant.wire, () => this.check(grant))
      const overview = await grant.design.initialize(input.draftTargetingVerified)
      this.check(grant)

      if (grant.design.writable) {
        grant.lease.acquire()
      }

      const reference = this.save(grant, { overview })
      grant.ready = true
      return {
        outcome: 'ok',
        attachmentId: grant.id,
        writable: grant.design.writable,
        snapshot: reference,
      } as const
    } catch (error) {
      const failure = reason(error)
      return { outcome: (await this.close(grant, failure)) ?? failure } as const
    }
  }

  private owned(owner: Owner) {
    const grant = this.active

    if (!grant) {
      fail('detached')
    }

    if (!sameOwner(grant.owner, owner)) {
      fail('denied')
    }

    return grant
  }

  private authorized(owner: Owner, attachmentId: string) {
    const grant = this.owned(owner)

    if (grant.id !== attachmentId) {
      fail('denied')
    }

    this.check(grant)

    if (!grant.ready || !grant.design) {
      fail('busy')
    }

    return grant
  }

  status(owner: Owner) {
    try {
      const grant = this.owned(owner)
      this.check(grant)
      return {
        outcome: 'ok',
        attachmentId: grant.id,
        ready: grant.ready,
        writable: grant.ready && !!grant.design?.writable,
        target: structuredClone(grant.target),
        remainingMs: Math.max(0, Math.ceil(grant.until - performance.now())),
      } as const
    } catch (error) {
      return { outcome: reason(error) } as const
    }
  }

  tools(owner: Owner, attachmentId: string) {
    try {
      return descriptors(!!this.authorized(owner, attachmentId).design?.writable)
    } catch {

      // A worker without a current capability sees no Paper tools.
      return []
    }
  }

  /** Only this projection crosses into a design worker or its read-only advisor adapter. */
  bind(owner: Owner, attachmentId: string, access: 'design' | 'read') {
    if (access !== 'design' && access !== 'read') {
      fail('denied')
    }

    const bound: Owner = {
      sessionId: owner.sessionId,
      taskId: owner.taskId,
      worktree: owner.worktree,
    }
    const allowed = new Set(descriptors(access === 'design').map((tool) => tool.name))
    return {
      tools: () => this.tools(bound, attachmentId).filter((tool) => allowed.has(tool.name)),
      call: async (name: string, args: unknown) => {
        if (!allowed.has(name)) {
          return { outcome: 'denied' } as const
        }

        return this.call(bound, attachmentId, name, args)
      },
    }
  }

  private async operation<T>(
    owner: Owner,
    attachmentId: string,
    run: (grant: Grant, design: Design) => Promise<T>,
  ): Promise<Result<T>> {
    let grant: Grant

    try {
      grant = this.authorized(owner, attachmentId)

      if (grant.busy || !grant.design) {
        fail('busy')
      }
    } catch (error) {
      return { outcome: reason(error) }
    }

    grant.busy = true

    try {
      if (++grant.operations > limits.calls) {
        fail('limit')
      }

      const value = await run(grant, grant.design)
      this.check(grant)
      return { outcome: 'ok', value }
    } catch (error) {
      const failure = reason(error)
      const rejected = failure === 'denied' || failure === 'invalid' || failure === 'read_only'

      if (rejected && ++grant.errors < limits.errors) {
        return { outcome: failure }
      }

      const terminal = rejected ? 'limit' : failure
      return { outcome: (await this.close(grant, terminal)) ?? terminal }
    } finally {
      grant.busy = false
    }
  }

  call(owner: Owner, attachmentId: string, name: string, args: unknown) {
    return this.operation(owner, attachmentId, async (_grant, design) => ({
      untrusted: true as const,
      content: [await design.dispatch(name, args)],
    }))
  }

  capture(owner: Owner, attachmentId: string, nodeId: string) {
    return this.operation(owner, attachmentId, async (grant, design) => {
      const node = await design.dispatch('paper_node', { nodeId })
      const image = await design.dispatch('paper_screenshot', { nodeId })
      return this.save(grant, { nodeId, node, image })
    })
  }

  async detach(owner: Owner, attachmentId: string) {
    try {
      const grant = this.owned(owner)

      if (grant.id !== attachmentId) {
        fail('denied')
      }

      return { outcome: (await this.close(grant, 'detached')) ?? 'ok' } as const
    } catch (error) {
      return { outcome: reason(error) } as const
    }
  }
}
