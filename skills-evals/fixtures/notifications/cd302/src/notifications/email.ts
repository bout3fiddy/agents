import type { Notification, SendResult } from "./types";

// NOTE: validated against our email provider contract
export async function sendEmail(n: Notification): Promise<SendResult> {
  const response = await fetch("https://api.mailprovider.example/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: n.to,
      subject: n.subject,
      html: n.body,
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `Email send failed: ${response.status}` };
  }

  const data = await response.json();
  return { ok: true, messageId: data.id };
}
