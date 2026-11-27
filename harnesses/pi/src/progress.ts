import { atomicJson, readJson } from './state.ts'

import type { ModelRoute } from './contracts.ts'

export type TaskProgress = Partial<ModelRoute> & {
  stage: string
  updatedAt: string
  role?: string
  tool?: string
  message?: string
  child?: TaskProgress
  summary?: string
  milestone?: string
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
