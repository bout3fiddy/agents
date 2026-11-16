import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson, readJson, type StateStore } from './state.ts'
import { harnessRoot } from './project.ts'
import { loadRole } from './roles.ts'
import type { WorkerEvidence, WorkerRequest } from './contracts.ts'

export type Dispatcher = (
  request: Omit<WorkerRequest, 'outputPath'>,
  signal?: AbortSignal,
) => Promise<WorkerEvidence>

export function dispatcher(store: StateStore): Dispatcher {
  return async (request, signal) => {
    signal?.throwIfAborted()
    const id = randomUUID()
    const path = join(store.directory, 'attempts', `${id}.json`)
    const outputPath = join(store.directory, 'attempts', `${id}.result.json`)
    await atomicJson(path, { ...request, outputPath })
    await atomicJson(`${path}.status`, { status: 'dispatched', role: request.role })
    const role = await loadRole(request.role)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(harnessRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
          join(harnessRoot, 'src', 'worker.ts'),
          '--worker',
          path,
        ],
        {
          cwd: harnessRoot,
          env: { ...process.env, PI_HARNESS_WORKER: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        },
      )
      let diagnostics = ''
      const capture = (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-4000)
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              reject(error)
            }
          }
        }
      }
      const timer = setTimeout(kill, role.timeoutMs + 15000)
      signal?.addEventListener('abort', kill, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', kill)
      }
      child.once('error', (error) => {
        cleanup()
        reject(error)
      })
      child.once('close', (code) => {
        cleanup()
        kill()
        void atomicJson(`${path}.status`, {
          status: code === 0 ? 'finished' : 'failed',
          code,
        }).then(() => {
          if (signal?.aborted) {
            reject(new Error('Worker cancelled'))
          } else if (code === null) {
            reject(new Error(`Worker terminated: ${diagnostics}`))
          } else {
            resolve()
          }
        }, reject)
      })
    })
    const output = await readJson<{ evidence?: WorkerEvidence; error?: string }>(outputPath)

    if (!output?.evidence) {
      throw new Error(output?.error ?? 'Worker exited without a result')
    }

    return output.evidence
  }
}
