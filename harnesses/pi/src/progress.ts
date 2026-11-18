import { atomicJson, readJson } from './state.ts'
import type { Dispatcher } from './dispatch.ts'

export type TaskProgress = {
  stage: string
  updatedAt: string
  role?: string
  tool?: string
  message?: string
  child?: TaskProgress
  summary?: string
}

/** Each process owns one progress file; parent records point to the active child. */
export function progressReporter(output: string, role?: string) {
  const path = `${output}.progress.json`
  let latest: TaskProgress = { stage: 'starting', role, updatedAt: new Date().toISOString() }
  let writes = Promise.resolve()
  let lastStream = 0
  return {
    path,
    update(change: Partial<TaskProgress>, streaming = false) {
      const now = Date.now()

      if (streaming && now - lastStream < 1000) {
        return writes
      }

      lastStream = now
      latest = { ...latest, ...change, updatedAt: new Date(now).toISOString() }
      const captured = latest
      writes = writes.then(() => atomicJson(path, captured))
      return writes
    },
    settle: () => writes,
  }
}

export async function readProgress(output: string): Promise<TaskProgress | undefined> {
  const progress = await readJson<TaskProgress>(`${output}.progress.json`)
  const summary = await readJson<{ summary: string }>(`${output}.summary.json`)
  return progress ? { ...progress, ...(summary ? { summary: summary.summary } : {}) } : undefined
}

/** Accepted workflows use the same parent-visible activity stream as task coordinators. */
export function trackDispatch(dispatch: Dispatcher, output: string): Dispatcher {
  const progress = progressReporter(output)
  return async (request, signal, observer) => {
    await progress.update({ stage: 'child', role: request.role, child: undefined })

    try {
      const evidence = await dispatch(request, signal, async (activity) => {
        await progress.update({ stage: 'child', child: activity })
        await observer?.(activity)
      })
      await progress.update({
        stage: 'checking',
        child: undefined,
        message: `${request.role}: ${evidence.result.verdict}. ${evidence.result.summary}`,
      })
      return evidence
    } catch (error) {
      await progress.update({ stage: 'issue', child: undefined, message: String(error) })
      throw error
    }
  }
}
