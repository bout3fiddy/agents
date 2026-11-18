import { dirname } from 'node:path'
import type { TaskCoordinatorRequest, TaskCoordinatorEvidence } from './task-coordinator.ts'
import type { TaskControls } from './delegation-state.ts'
import { dispatcher } from './dispatch.ts'
import { trackDispatch } from './progress.ts'
import { readJson, StateStore } from './state.ts'

/** Dispatch one read-only Fable worker directly on the ordinary delegated snapshot. */
export async function runProgressAuditor(
  request: TaskCoordinatorRequest,
  signal: AbortSignal,
): Promise<TaskCoordinatorEvidence> {
  if (request.kind !== 'research' || request.checkpoint.writePaths.length) {
    throw new Error('Progress audits require read-only research scope')
  }

  const store = new StateStore(request.project.root, dirname(request.outputPath))
  const dispatch = trackDispatch(dispatcher(store), request.outputPath)
  const controls = request.controlsPath
    ? await readJson<TaskControls>(request.controlsPath)
    : undefined
  const task = [request.task, ...(controls?.messages.map((m) => m.text) ?? [])].join('\n\n')
  const evidence = await dispatch(
    {
      role: 'progress-auditor',
      task,
      workspace: request.workspace,
      project: request.project,
      checkpoint: request.checkpoint,
      model: request.model,
      thinking: request.thinking ?? 'medium',
      decideContinuation: request.decideContinuation,
      baseline: request.baseline,
      changedFiles: [],
    },
    signal,
  )
  return {
    result: evidence.result,
    children: [evidence],
    model: evidence.model,
    thinking: evidence.thinking,
    turns: evidence.turns,
    controlRevision: controls?.revision ?? 0,
  }
}
