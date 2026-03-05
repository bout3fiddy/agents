export enum Channel {
  EMAIL = "email",
  SLACK = "slack",
}

export interface Notification {
  id: string;
  channel: Channel;
  to: string;
  subject: string;
  body: string;
  metadata?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}
