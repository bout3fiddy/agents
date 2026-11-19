import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson, readJson, type StateStore } from './state.ts'
import { harnessRoot } from './project.ts'
import { loadRole } from './roles.ts'
import { ProviderQuotaError, type WorkerEvidence, type WorkerRequest } from './contracts.ts'
import { readProgress, type TaskProgress } from './progress.ts'

export type Dispatcher = (
  request: Omit<WorkerRequest, 'outputPath'>,
  signal?: AbortSignal,
  progress?: (value: TaskProgress) => Promise<void>,
) => Promise<WorkerEvidence>

/** Hold the candidate until every worker settles, including when a sibling fails. */
export async function collectWorkerResults<T>(
  attempts: Promise<T>[],
  persist: (finished: T[]) => Promise<void>,
): Promise<T[]> {
  const outcomes = await Promise.allSettled(attempts)
  const finished = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : [],
  )
  await persist(finished)
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected')

  if (failures.length === 1) {
    throw failures[0]!.reason
  }

  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      failures.map((failure) => String(failure.reason)).join(' / '),
    )
  }

  return finished
}

export async function runWorkerProcess(
  argv: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; diagnostics: string }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: harnessRoot,
      env: { ...process.env, PI_HARNESS_WORKER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let diagnostics = ''
    let timedOut = false
    let termination: Promise<void> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const capture = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const signalGroup = (value: NodeJS.Signals) => {
      if (!child.pid) {
        return
      }

      try {
        process.kill(-child.pid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          reject(error)
        }
      }
    }
    const terminate = () => {
      termination ??= new Promise<void>((settled) => {
        signalGroup('SIGTERM')
        forceTimer = setTimeout(() => {
          signalGroup('SIGKILL')
          settled()
        }, 1000)
      })
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminate()
          }, timeoutMs)
        : undefined
    signal?.addEventListener('abort', terminate, { once: true })

    if (signal?.aborted) {
      terminate()
    }

    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', terminate)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {

      // Let all group members forward SIGTERM to their separate sandbox groups before killing
      // lingering bridge/provider processes, even if the main worker exits immediately.
      void Promise.resolve(termination).then(() => {
        cleanup()
        signalGroup('SIGKILL')

        if (signal?.aborted) {
          reject(new Error('Worker cancelled'))
        } else if (timedOut) {
          reject(new Error('Worker exceeded its execution time budget'))
        } else if (code === null) {
          reject(new Error(`Worker terminated: ${diagnostics}`))
        } else {
          resolve({ code, diagnostics })
        }
      }, reject)
    })
  })
}

export function dispatcher(store: StateStore): Dispatcher {
  return async (request, signal, progress) => {
    signal?.throwIfAborted()
    const id = randomUUID()
    const path = join(store.directory, 'attempts', `${id}.json`)
    const outputPath = join(store.directory, 'attempts', `${id}.result.json`)
    await atomicJson(path, { ...request, outputPath })
    await atomicJson(`${path}.status`, { status: 'dispatched', role: request.role })
    await loadRole(request.role, request.thinking, request.implementerModel)
    let lastActivity = ''
    let pending = Promise.resolve()
    const observe = () => {
      pending = pending.then(async () => {
        const value = await readProgress(outputPath)

        if (value && value.updatedAt !== lastActivity) {
          lastActivity = value.updatedAt
          await progress?.(value)
        }
      })
      return pending
    }
    const observer = progress
      ? setInterval(() => {
          void observe().catch(() => {})
        }, 1000)
      : undefined

    try {
      const outcome = await runWorkerProcess(
        [
          '--import',
          join(harnessRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
          join(harnessRoot, 'src', 'worker.ts'),
          '--worker',
          path,
        ],
        0,
        signal,
      )
      await atomicJson(`${path}.status`, {
        status: outcome.code === 0 ? 'finished' : 'failed',
        code: outcome.code,
      })
      const output = await readJson<{
        evidence?: WorkerEvidence
        error?: string
        quotaRetryAt?: number
      }>(outputPath)
      signal?.throwIfAborted()

      if (outcome.code !== 0 || !output?.evidence) {
        if (output?.error && output.quotaRetryAt && Number.isSafeInteger(output.quotaRetryAt)) {
          throw new ProviderQuotaError(output.error, output.quotaRetryAt)
        }

        throw new Error(output?.error ?? `Worker exited without a result: ${outcome.diagnostics}`)
      }

      return output.evidence
    } catch (error) {
      await atomicJson(`${path}.status`, {
        status: signal?.aborted ? 'cancelled' : 'failed',
        error: String(error),
      })
      throw error
    } finally {
      clearInterval(observer)
      await observe()
    }
  }
}
