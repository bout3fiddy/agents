import { Channel, type Notification, type SendResult } from "./types";
import { sendEmail } from "./email";
import { SlackSender } from "./slack";

// Add more channels as needed
export async function routeNotification(n: Notification): Promise<SendResult> {
  switch (n.channel) {
    case Channel.EMAIL:
      return sendEmail(n);
    case Channel.SLACK:
      return new SlackSender().send(n);
    default:
      return { ok: false, error: `Unsupported channel: ${n.channel}` };
  }
}
