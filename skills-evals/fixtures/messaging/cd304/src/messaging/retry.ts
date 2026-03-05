import type { SendResult } from "./types";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export async function withRetry(
  fn: () => Promise<SendResult>,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): Promise<SendResult> {
  let lastResult: SendResult = { ok: false, error: "no attempts made" };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await fn();
    if (lastResult.ok) return lastResult;

    if (attempt < maxRetries) {
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return lastResult;
}
