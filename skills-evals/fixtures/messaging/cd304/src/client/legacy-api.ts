// @deprecated — use api.ts. Keeping for rollback safety until Q2.
import type { SendResult } from "../messaging/types";

export async function sendMessageV1(
  to: string,
  body: string,
): Promise<SendResult> {
  const response = await fetch("https://messaging.internal/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, body }),
  });

  if (!response.ok) {
    return { ok: false, error: `v1 send failed: ${response.status}` };
  }

  return { ok: true };
}
