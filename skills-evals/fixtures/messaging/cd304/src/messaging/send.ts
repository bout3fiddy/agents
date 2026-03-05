import { sendMessageV1 } from "../client/legacy-api";
import type { SendResult } from "./types";
import { withRetry } from "./retry";

// TODO: migrate to new API — see JIRA-1234
export async function sendNotification(
  to: string,
  body: string,
): Promise<SendResult> {
  return withRetry(() => sendMessageV1(to, body));
}
