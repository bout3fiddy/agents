import { join } from 'node:path'
import { readJson, type StateStore, type TaskState } from './state.ts'
import type { Checkpoint } from './contracts.ts'
import { fileHashes, inventory, snapshotHash, writable } from './paths.ts'
import { changes } from './integration.ts'

export async function retainedCandidate(
  store: StateStore,
  checkpoint: Checkpoint,
  before: Map<string, Buffer>,
): Promise<{ task: TaskState; readyForReview: boolean } | undefined> {
  const task = await store.task()

  if (
    !task?.candidate ||
    task.designHash !== checkpoint.hash ||
    (task.designVersion !== undefined && task.designVersion !== checkpoint.version) ||
    !['interrupted', 'needs_attention'].includes(task.status) ||
    task.phase === 'integration'
  ) {
    return undefined
  }

  const baseline = await readJson<Record<string, string>>(
    join(store.directory, 'tasks', `${task.id}.baseline.json`),
  )

  if (JSON.stringify(baseline) !== JSON.stringify(fileHashes(before))) {
    throw new Error('Retained candidate baseline changed; inspect it before accepting a new design')
  }

  const candidate = await inventory(task.candidate)

  if (changes(before, candidate).some((path) => !writable(path, checkpoint.writePaths))) {
    throw new Error('Retained candidate contains out-of-scope edits')
  }

  const current = task.evidence.filter((item) => item.snapshot === task.snapshot)
  const readyForReview =
    task.phase === 'review' &&
    task.snapshot === snapshotHash(candidate) &&
    (task.reviewRound?.snapshot === task.snapshot ||
      current.every((item) => item.result.verdict === 'pass')) &&
    (!checkpoint.performanceReview || current.some((item) => item.role === 'performance'))
  return { task, readyForReview }
}
