import { join } from 'node:path'
import {
  activeTask,
  delegationDirectory,
  observedTaskState,
  type Delegation,
  type DelegationStatus,
} from './delegation-state.ts'
import { readBoundedFile } from './paths.ts'
import type { TaskProgress } from './progress.ts'
import type { StateStore } from './state.ts'
import { WorkerRoots, safeTrace, type WorkerOrigin } from './worker-roots.ts'

function label(id: string, role: string, stage: string): string {
  return `${id.slice(0, 6)} ${role}/${stage}`
}

// External progress is optional display data, not arbitrary terminal text.
function progressLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w. -]{1,64}$/u.test(value) ? value : undefined
}

async function externalLabel(store: StateStore, state: DelegationStatus): Promise<string> {
  const output = state.progressFile ?? 'coordinator.json'
  const path = join(delegationDirectory(store, state.id), `${output}.progress.json`)
  let progress: TaskProgress | undefined

  try {
    const data = await readBoundedFile(await safeTrace(store, path), 32 * 1024)
    progress = JSON.parse(data.toString()) as TaskProgress
  } catch {
    // Missing or unreadable progress must not hide an otherwise validated active task.
  }

  const role = progressLabel(progress?.role) ?? state.status
  const stage = progressLabel(progress?.child?.tool) ?? progressLabel(progress?.stage) ?? 'starting'
  return label(state.id, role, stage)
}

/** Read only the registered tasks, never a remote project's worker list or conversations. */
export async function taskStatusLine(store: StateStore, jobs: Delegation[], session: string) {
  const labels = jobs
    .filter(({ state }) => activeTask(state))
    .map(({ request, state }) =>
      label(
        request.id,
        state.progress?.role ?? state.status,
        state.progress?.child?.tool ?? state.progress?.stage ?? 'starting',
      ),
    )
  const roots = new WorkerRoots(store)
  let entries: WorkerOrigin[] = []

  try {
    entries = await roots.entries()
  } catch {
    // An unavailable external registry must not stop the observer or hide local jobs.
  }

  const seen = new Set<string>()

  for (const entry of entries) {
    if (entry?.session !== session || entry.root === store.projectRoot) {
      continue
    }

    try {
      const key = JSON.stringify([entry.root, entry.taskId])

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      const owner = await roots.owner(entry)

      if (activeTask(observedTaskState(owner.state))) {
        labels.push(await externalLabel(owner.store, owner.state))
      }
    } catch {
      // A stale or invalid registration cannot speak for its owner. Try the next entry.
    }
  }

  return labels.length ? 'Tasks · ' + labels.join(' · ') : undefined
}
