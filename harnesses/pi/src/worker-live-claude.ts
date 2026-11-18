import { StringDecoder } from 'node:string_decoder'
import { LiveWorker, messageText } from './worker-live.ts'

type ClaudeEvent = {
  type?: string
  message?: { role?: string; content?: { type: string; name?: string }[] }
  event?: { type?: string; delta?: { type?: string; text?: string } }
}

export class ClaudeLiveTrace {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private partial = ''

  constructor(private readonly live: LiveWorker) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk)
    let newline = this.pending.indexOf('\n')

    while (newline >= 0) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)

      if (line.trim()) {
        this.event(JSON.parse(line) as ClaudeEvent)
      }

      newline = this.pending.indexOf('\n')
    }
  }

  private event(event: ClaudeEvent): void {
    if (event.type === 'stream_event') {
      if (event.event?.type === 'message_start') {
        this.partial = ''
      }

      if (event.event?.delta?.type === 'text_delta') {
        this.partial += event.event.delta.text ?? ''
        void this.live.update({ stage: 'model', partial: this.partial }, true).catch(() => {})
      }
    }

    if (event.message) {
      void this.live
        .append(event.message.role ?? event.type ?? 'message', messageText(event.message))
        .catch(() => {})
      const tool = event.message.content?.find((part) => part.type === 'tool_use')
      void this.live
        .update({
          stage: tool ? 'tool' : 'model',
          tool: tool?.name,
          partial: undefined,
        })
        .catch(() => {})
      this.partial = ''
    }
  }
}
