import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { atomicJson, readJson, type StateStore } from './state.ts'
import { createWorkspace } from './project.ts'
import {
  digest,
  fileHashes,
  inventory,
  matches,
  safePath,
  snapshotHash,
  validateWriteScope,
  writable,
} from './paths.ts'
import { writePathSchema } from './contracts.ts'
import { changes } from './integration.ts'
import {
  handoffForResume,
  scopesOverlap,
  ownsTaskPaths,
  type Delegations,
  type DelegationRequest,
  type DelegationStatus,
  type TaskControls,
} from './delegation-state.ts'

export const implementationRecovery =
  'Local implementation has a fixed design. Send verified observations to a running implementer ' +
  'with task_control action=evidence. For paused, failed or needs_attention tasks, use ' +
  'resume_task when unblocked and the assignment is unchanged. For a changed assignment, ' +
  'preserve the candidate and use workflow with the revised design after the reservation clears.'

export const revisionSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 36, maxLength: 36 }),
      task: Type.String({ minLength: 1, maxLength: 8000 }),
      context: Type.String({ maxLength: 24000 }),
      writePaths: Type.Optional(Type.Array(writePathSchema, { maxItems: 30 })),
    }),
    { minItems: 1, maxItems: 4 },
  ),
})
type Revision = Static<typeof revisionSchema>
type Plan = {
  request: DelegationRequest
  state: DelegationStatus
  controls: TaskControls
  baseline?: Record<string, string>
  workspace?: { workspace: string; originals: string }
}
type Journal = { id: string; plans: Plan[]; previous: unknown[] }

/** Replay only prepared metadata. All participants were stopped before the journal was written. */
export async function recoverTaskRevision(store: StateStore): Promise<void> {
  const path = join(store.directory, 'delegations', 'pending-revision.json')
  const journal = await readJson<Journal>(path)

  if (!journal) {
    return
  }

  if (
    !Array.isArray(journal.plans) ||
    !journal.plans.length ||
    journal.plans.length > 4 ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    new Set(journal.plans.map((plan) => plan.request?.id)).size !== journal.plans.length ||
    journal.plans.some(
      (plan) =>
        !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(plan.request?.id) ||
        plan.request.root !== store.projectRoot ||
        plan.state.id !== plan.request.id ||
        plan.state.status !== 'paused' ||
        !plan.controls.paused ||
        plan.controls.cancelled,
    )
  ) {
    throw new Error('Invalid task revision journal')
  }

  for (const plan of journal.plans) {
    const directory = join(store.directory, 'delegations', plan.request.id)

    if (plan.workspace) {
      await atomicJson(join(directory, 'workspace.json'), plan.workspace)
    }

    if (plan.baseline) {
      await atomicJson(join(directory, 'baseline.json'), plan.baseline)
    }

    await atomicJson(join(directory, 'request.json'), plan.request)
    await atomicJson(join(directory, 'controls.json'), plan.controls)
    await atomicJson(join(directory, 'status.json'), plan.state)
  }

  await atomicJson(join(store.directory, 'delegations', 'revisions', `${journal.id}.json`), journal)
  await rm(path)
}

function contained(scopes: string[], authority: string[]) {
  return scopes.every((scope) =>
    authority.some(
      (outer) =>
        outer === '**' ||
        scope === outer ||
        (scope !== '**' &&
          outer.endsWith('/**') &&
          matches(scope.endsWith('/**') ? scope.slice(0, -3) : scope, outer)),
    ),
  )
}

export async function reviseTasks(jobs: Delegations, raw: Revision) {
  if (
    !Check(revisionSchema, raw) ||
    new Set(raw.tasks.map((task) => task.id)).size !== raw.tasks.length
  ) {
    throw new Error('Provide distinct paused tasks and revised assignments')
  }

  return jobs.locked(async () => {
    const selected = await Promise.all(raw.tasks.map((task) => jobs.get(task.id)))

    const fixed = selected.find((job) => job.request.kind === 'implementation')

    if (fixed) {
      throw new Error(`Task ${fixed.request.id}: ${implementationRecovery}`)
    }

    for (const job of selected) {
      if (!['paused', 'needs_attention', 'failed'].includes(job.state.status)) {
        throw new Error('Pause every selected task and await acknowledgement before revising scope')
      }
    }

    if (
      selected.some((job) => job.request.kind === 'branch') &&
      selected.some((job) => job.request.kind !== 'branch')
    ) {
      throw new Error('Revise branch tasks and local tasks in separate batches')
    }

    const updates = raw.tasks.map((task, index) => ({
      ...task,
      writePaths: task.writePaths ?? selected[index]!.request.writePaths,
    }))
    const authority = selected.flatMap((job) => job.request.writePaths)
    const previous = await Promise.all(
      selected.map(async (job) => {
        const directory = join(jobs.store.directory, 'delegations', job.request.id)
        return {
          ...job,
          workspace: await readJson(join(directory, 'workspace.json')),
          baseline: await readJson(join(directory, 'baseline.json')),
          controls: await readJson(join(directory, 'controls.json')),
        }
      }),
    )
    const others = (await jobs.list()).filter(
      (job) => !updates.some((task) => task.id === job.request.id) && ownsTaskPaths(job.state),
    )

    for (const [index, task] of updates.entries()) {
      validateWriteScope(task.writePaths, selected[index]!.request.writePaths)
      const kind = selected[index]!.request.kind

      if (
        (kind === 'research' && task.writePaths.length) ||
        (kind === 'documents' && (!task.writePaths.length || task.writePaths.includes('**')))
      ) {
        throw new Error('Revised scope must preserve the task kind restrictions')
      }

      if (
        kind === 'branch' &&
        JSON.stringify(task.writePaths) !== JSON.stringify(selected[index]!.request.writePaths)
      ) {
        throw new Error('Keep branch ownership fixed; split remaining work into new tasks')
      }

      if (!contained(task.writePaths, authority)) {
        throw new Error('Scope expansion exceeds these tasks; obtain authorization for a new task')
      }

      const sameMode = others.filter(
        (job) => (job.request.kind === 'branch') === (selected[index]!.request.kind === 'branch'),
      )

      if (
        updates.slice(0, index).some((other) => scopesOverlap(task.writePaths, other.writePaths)) ||
        sameMode.some((other) => scopesOverlap(task.writePaths, other.request.writePaths))
      ) {
        throw new Error('Revised tasks still have colliding write scopes')
      }
    }

    const root = await inventory(jobs.store.projectRoot)
    const retained = new Map<string, Buffer | undefined>()

    for (const job of selected) {
      if (job.request.kind === 'branch') {
        continue
      }

      if (!job.state.candidate) {
        continue
      }

      const baseline = await readJson<Record<string, string>>(
        join(jobs.store.directory, 'delegations', job.request.id, 'baseline.json'),
      )

      if (!baseline) {
        throw new Error('Missing candidate baseline; inspect retained evidence')
      }

      const candidate = await inventory(job.state.candidate)

      for (const path of new Set([...Object.keys(baseline), ...candidate.keys()])) {
        const value = candidate.get(path)
        const hash = value === undefined ? undefined : digest(value)

        if (hash === baseline[path]) {
          continue
        }

        if (!writable(path, job.request.writePaths)) {
          throw new Error(`Retained edit outside original scope: ${path}`)
        }

        const current = root.get(path)
        const currentHash = current === undefined ? undefined : digest(current)

        if (currentHash !== baseline[path] && currentHash !== hash) {
          throw new Error(`Concurrent project edit requires reconciliation: ${path}`)
        }

        const earlier = retained.get(path)

        if (
          retained.has(path) &&
          (earlier === undefined ? value !== undefined : !value || !earlier.equals(value))
        ) {
          throw new Error(`Conflicting retained edits require host reconciliation: ${path}`)
        }

        retained.set(path, value)
      }
    }

    for (const path of retained.keys()) {
      const owner = updates.findIndex((task) => writable(path, task.writePaths))

      if (owner === -1) {
        throw new Error(`Retained edit has no owner in the revision: ${path}`)
      }

      if (
        selected[owner]!.request.kind === 'documents' &&
        !['.md', '.txt', '.rst'].includes(extname(path))
      ) {
        throw new Error(`Document task cannot inherit code edits: ${path}`)
      }
    }

    const plans: Plan[] = []
    const staged: string[] = []
    let prepared = false

    try {
      for (const [index, update] of updates.entries()) {
        const job = selected[index]!
        const directory = join(jobs.store.directory, 'delegations', job.request.id)
        const control = await readJson<TaskControls>(join(directory, 'controls.json'))

        if (!control) {
          throw new Error('Task controls are unavailable')
        }

        const request = {
          ...job.request,
          task: update.task,
          context: update.context,
          writePaths: update.writePaths,
        }
        const state: DelegationStatus = {
          ...job.state,
          status: 'paused',
          pid: undefined,
          updatedAt: new Date().toISOString(),
          error: undefined,
          receipts: undefined,
          children: undefined,
          hostActions: undefined,
          summary: 'Assignment revised; awaiting resume',
          progressFile: `coordinator-${randomUUID()}.json`,
        }
        const plan: Plan = {
          request,
          state,
          controls: {
            ...control,
            previousHostHandoff: handoffForResume(job, control),
            cancelled: false,
            paused: true,
            baseRevision: control.revision,
            revision: control.revision + 1,
            messages: [
              {
                revision: control.revision + 1,
                text:
                  'Assignment revised. Follow the current task, context and write scope. ' +
                  'Earlier incompatible instructions and review approvals are superseded.',
              },
            ],
          },
        }

        if (request.kind !== 'branch') {
          const originals = await createWorkspace(jobs.store.projectRoot)
          staged.push(originals)
          const workspace = await createWorkspace(originals)
          staged.push(workspace)

          if (
            snapshotHash(await inventory(originals)) !== snapshotHash(root) ||
            snapshotHash(await inventory(workspace)) !== snapshotHash(root)
          ) {
            throw new Error(
              'Project changed while preparing revised candidates; retry after inspection',
            )
          }

          for (const [path, bytes] of retained) {
            if (!writable(path, update.writePaths)) {
              continue
            }

            const target = await safePath(workspace, path)

            if (bytes === undefined) {
              await rm(target, { force: true })
            } else {
              await mkdir(dirname(target), { recursive: true })
              await writeFile(target, bytes)
            }
          }

          plan.workspace = { workspace, originals }
          plan.baseline = fileHashes(root)
          state.candidate = workspace
          state.changedPaths = changes(root, await inventory(workspace))
        }

        plans.push(plan)
      }

      if (snapshotHash(await inventory(jobs.store.projectRoot)) !== snapshotHash(root)) {
        throw new Error('Project changed during revision; retry after inspection')
      }

      await atomicJson(join(jobs.store.directory, 'delegations', 'pending-revision.json'), {
        id: randomUUID(),
        plans,
        previous,
      } satisfies Journal)
      prepared = true
      await recoverTaskRevision(jobs.store)
      return Promise.all(plans.map((plan) => jobs.get(plan.request.id)))
    } finally {
      if (!prepared) {
        await Promise.all(staged.map((path) => rm(path, { recursive: true, force: true })))
      }
    }
  })
}
