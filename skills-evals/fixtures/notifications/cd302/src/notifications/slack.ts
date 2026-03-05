import type { Notification, SendResult } from "./types";

export class SlackSender {
  private webhookUrl: string;

  constructor(webhookUrl = "https://hooks.slack.com/services/default") {
    this.webhookUrl = webhookUrl;
  }

  async send(n: Notification): Promise<SendResult> {
    const payload = {
      channel: n.to,
      text: `*${n.subject}*\n${n.body}`,
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { ok: false, error: `Slack send failed: ${response.status}` };
    }

    return { ok: true, messageId: `slack-${Date.now()}` };
  }
}
