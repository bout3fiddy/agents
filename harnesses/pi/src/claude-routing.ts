import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderQuotaError, type ModelRoute, type Role } from './contracts.ts'
import { atomicJson, readJson } from './state.ts'

export const quotaMaxAgeMs = 15 * 60 * 1000

type QuotaReceipt = { version: 1; confirmedAt: number; retryAt: number }

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
}

function fresh(
  receipt: Partial<QuotaReceipt> | null | undefined,
  now: number,
): receipt is QuotaReceipt {
  return (
    receipt?.version === 1 &&
    timestamp(now) &&
    timestamp(receipt.confirmedAt) &&
    timestamp(receipt.retryAt) &&
    receipt.confirmedAt <= now &&
    now - receipt.confirmedAt < quotaMaxAgeMs &&
    now < receipt.retryAt
  )
}

async function readQuota(path: string) {
  try {
    return await readJson<Partial<QuotaReceipt> | null>(path)
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }

    // A truncated or otherwise malformed receipt cannot authorize fallback.
    return null
  }
}

/** CLI workers are independent processes sharing one subscription. */
export async function routeClaude<T>(
  role: Role,
  attempt: (selected: Role, retry: boolean, route: ModelRoute) => Promise<T>,
  directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
  now = Date.now,
): Promise<T> {
  const preferred = { requestedModel: role.model, actualModel: role.model }

  if (role.model !== 'claude-fable-5-2') {
    return attempt(role, false, preferred)
  }

  const path = join(directory, 'quota', role.model + '.json')
  const cached = await readQuota(path)
  let receipt: QuotaReceipt
  let retry = false

  if (fresh(cached, now())) {
    receipt = cached
  } else {
    try {
      const result = await attempt(role, false, preferred)

      if (cached !== undefined && !fresh(await readQuota(path), now())) {
        await rm(path, { force: true })
      }

      return result
    } catch (error) {
      const confirmedAt = now()

      if (
        !(error instanceof ProviderQuotaError) ||
        !timestamp(confirmedAt) ||
        !timestamp(error.retryAt) ||
        error.retryAt <= confirmedAt
      ) {
        throw error
      }

      receipt = { version: 1, confirmedAt, retryAt: error.retryAt }
      await atomicJson(path, receipt)
      retry = true
    }
  }

  try {
    return await attempt({ ...role, model: 'opus' }, retry, {
      requestedModel: role.model,
      actualModel: 'opus',
      fallbackReason: retry ? 'quota-confirmed' : 'quota-cached',
      confirmedAt: receipt.confirmedAt,
      retryAt: receipt.retryAt,
    })
  } catch (error) {
    if (error instanceof ProviderQuotaError) {
      throw new ProviderQuotaError(
        'Fable and Opus have reached their usage limits. ' + error.message,
        Math.min(receipt.retryAt, error.retryAt),
      )
    }

    throw error
  }
}
