import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderQuotaError, type Role } from './contracts.ts'
import { atomicJson, readJson } from './state.ts'

/** CLI workers are independent processes sharing one subscription. */
export async function routeClaude<T>(
  role: Role,
  attempt: (selected: Role, retry: boolean) => Promise<T>,
  directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
): Promise<T> {
  if (role.name === 'implementer' || role.model !== 'claude-fable-5-2') {
    return attempt(role, false)
  }

  const path = join(directory, 'quota', role.model + '.json')
  let reset = (await readJson<{ retryAt: number }>(path))?.retryAt ?? 0

  const tryPreferred = reset <= Date.now()

  if (tryPreferred) {
    try {
      return await attempt(role, false)
    } catch (error) {
      if (!(error instanceof ProviderQuotaError)) {
        throw error
      }

      reset = error.retryAt
      await atomicJson(path, { retryAt: reset })
    }
  }

  try {
    return await attempt({ ...role, model: 'opus' }, tryPreferred)
  } catch (error) {
    if (error instanceof ProviderQuotaError) {
      throw new ProviderQuotaError(
        'Fable and Opus have reached their usage limits. ' + error.message,
        Math.min(reset, error.retryAt),
      )
    }

    throw error
  }
}
