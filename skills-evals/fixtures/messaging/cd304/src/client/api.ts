import type { SendResult } from "../messaging/types";

export interface MessageParams {
  to: string;
  body: string;
  priority?: "low" | "normal" | "high";
}

export async function sendMessage(
  params: MessageParams,
): Promise<SendResult> {
  const response = await fetch("https://messaging.internal/v2/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    return { ok: false, error: `v2 send failed: ${response.status}` };
  }

  const data = await response.json();
  return { ok: true, messageId: data.messageId };
}
