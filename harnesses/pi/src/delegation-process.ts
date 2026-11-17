import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessRoot } from './project.ts'
import { StateStore } from './state.ts'
import { delegationDirectory, type DelegationRequest } from './delegation-state.ts'

export async function launchDelegation(request: DelegationRequest): Promise<void> {
  const directory = delegationDirectory(new StateStore(request.root), request.id)
  const log = await open(join(directory, 'supervisor.log'), 'a', 0o600)

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(harnessRoot, 'node_modules/tsx/dist/loader.mjs'),
          join(harnessRoot, 'src/delegation-runner.ts'),
          '--task',
          join(directory, 'request.json'),
        ],
        {
          cwd: harnessRoot,
          env: { ...process.env, PI_HARNESS_WORKER: '1' },
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
        },
      )
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  } finally {
    await log.close()
  }
}
