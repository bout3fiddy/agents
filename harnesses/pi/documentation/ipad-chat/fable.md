# iPad chat for a pih session: Fable design

Author: Fable 5.2 (`claude-fable-5-2`). Design only; nothing is built.

## Recommendation

Give the board daemon an optional text conversation. The owning pih session publishes an allowlisted
projection of its own transcript. iPad text re-enters that session as one receipted `custom_message`
per request, on the path `BoardFeed` already proves. Ship the read-only mirror first, input second,
streaming last. The board never calls a model.

## Evidence

Pinned SDK 1.5.2, read from lockfile-matched `node_modules` (`dist/core/extensions/types.d.ts`):

- 772–825: `BoundaryState.outcome` is `completed | aborted | error`; `AgentSettledEvent` has only
  `aborted`.
- 848–960: `TurnEndEvent.messageEntryId`, `message_update.assistantMessageEvent`,
  `InputEvent.source`, `tool_call` `parentToolCallId`.
- `agent-session.js:814–826` persists user messages at `message_end`: when consumed, not typed.

Repository: `src/whiteboard-feed.ts` (receipts in `details.ids`); `src/whiteboard-protocol.ts`
(`parsePoll` rejects an unknown event `kind`); `src/whiteboard.ts:12` (`whiteboard` includes
mutating `publish`, `ack`).

Supplied, not inspected: tldraw-sync facts. No web research. Routes and CLI fields are proposals.

## Outbound: project the branch

`/start_whiteboard chat` (proposed) shows a pairing QR. From opt-in onward pih publishes
`getBranch()` in branch order at `turn_end`, `agent_settled` and poll ticks:

- `message`, role `user`: text blocks and an image count.
- `message`, role `assistant`, `stopReason` `stop` or `length`: `type: 'text'` blocks only.
- `custom_message` of type `pi-ipad-chat`: the iPad's own text.

Everything else is denied by default, including thinking, tool calls and results, other custom
messages, the system prompt, traces and worker conversations.

## Inbound: one request, one custom message

`sendUserMessage` (lines 1303–1315) has no metadata field; a second receipt write would leave a
crash window. A `custom_message` (`pi-ipad-chat`,
`details: { owner, session, epoch, ids: [request] }`) holds text and receipt in one entry and never
dispatches commands.

Scheduling: one active request. `ChatFeed` offers only the queue head, when idle or at
`agent_before_settle` with outcome `completed` and no pending messages; never mid-run, so iPad text
cannot narrow a running terminal turn. The next waits until the head is final: two requests never
share a reply. `host_work` pauses still defer.

Authority is a provenance value enforced in code:

- It becomes `ipad(request)` when that entry is appended.
- It returns to `terminal` only at `message_end` for a user message matching an `input` event with
  `source: 'interactive'`. Queued terminal text changes nothing until consumed.
- Under `ipad`, `tool_call` allows only `project_read`, `project_search`, `harness_status`, and
  `whiteboard` with `action` `status` or `snapshot`. It blocks `publish`, `ack`, nested calls
  (`parentToolCallId`) and every unlisted tool.
- Restore recomputes it from the branch and stays `ipad` when unsure. Background wakes meanwhile
  also run read-only.

## Protocol

Proposed record; only `owner` and `session` exist today (`BoardLink`).

```text
v        1
owner    pih session id      session: board id
epoch    counter             bumps on tree navigation
seq      counter             daemon-assigned, increasing
id       entry/request id    upsert key
kind     message, request    role: user, assistant, ipad
text     ≤ 32 KB UTF-8
request  request id          on the ipad message and its reply
state    requests only       reason: failed only

sending → queued → received → working → completed
queued  → cancelled (iPad), failed (expired, branch_left)
working → failed (aborted, error), ambiguous
```

- Authority: the daemon alone writes one bounded JSON log per board, replaced atomically, and
  assigns `seq`. The session transcript decides receipts and replies.
- `queued` is the one durable accepted state, persisted before the 202. `sending` is iPad-local.
- Ordering: a queued request waits in a pending tray, then joins the transcript where its `ipad`
  record lands, matching the terminal.
- Cursor: `GET …/chat?epoch=<e>&after=<seq>`, long-polled. A stale epoch or evicted `after` returns
  `resync` with the whole window.
- Dedup: the tab stores a request ID and `basis` (last seen `seq`) with its draft. The daemon keeps
  64 tombstones (ID, text hash, state): same ID, same result; different text, 409. A `basis` older
  than the oldest tombstone gets 409 `resync`: old replays are rejected, not remembered forever.
- Limits: 8 KB input; 8 queued, then 429; 200 records or 1 MiB; one paired device.
- Inputs use a new top-level `chat` poll field, not a new event `kind`.

## Completion and recovery

`ChatFeed` records each boundary's `outcome`, final `stopReason` and `messageEntryId`. At
`agent_settled`:

- Outcome `completed`, not aborted, with a final assistant entry (`stop` or `length`) after the
  request: publish it with `request`. `completed` requires publish confirmation; upsert by entry ID
  yields one reply.
- Outcome `error` or `aborted`: `failed`, never `completed`.

On restore, a conclusive entry after the receipt resolves the same way. Otherwise the request is
`ambiguous` and final: the receipt blocks redelivery, nothing reruns the prompt, and the iPad says
"No confirmation. Check the terminal." No receipt means still `queued`. Tree navigation starts a new
epoch; requests receipted on an abandoned branch fail as `branch_left`. Forks get no access.

## Security

- TLS required; plain HTTP only on loopback.
- Pairing: a single-use, 120-second QR fragment code buys a chat-scoped token, distinct from event
  and host tokens, hashed at rest, expiring after 12 hours, held per tab in `sessionStorage`.
  Re-pairing revokes the previous tab; the terminal announces it.
- No cookies: an `Authorization` header, an Origin check, no CORS. Messages render as text nodes
  under a strict CSP.

## iPad experience

A chalk-white slip at the board edge, opened from the tool strip.

```text
┌────────────────────┬──────────────┐
│ ViewTabs           │ Chat         │
│ canvas ≥ 60%       │ iPad: Queued │
│ tool strip [Chat•] │ [Write…]     │
└────────────────────┴──────────────┘
```

Portrait: a bottom sheet at most 45% tall. Speakers differ by a hairline rule and indent, not
bubbles; existing palette, type and Notice. Pencil draws on the canvas and selects text in the
drawer. Hardware Return sends; on-screen Return breaks the line. Long messages fold after 24 lines
with Copy. Failure reads "Not delivered. Send again".

## Boundaries and proposed tests

pih gets a projection module and `ChatFeed` beside `BoardFeed`; tldraw-sync gets a chat store,
routes and `ChatDrawer`.

- Leak: capture-provider SDK tests plant canaries in thinking, tool results and the system prompt;
  none is published, and a negative control without the allowlist fails.
- Read-only denial: under `ipad`, `whiteboard publish`, `bash`, a nested call and an unknown tool
  are blocked; queued terminal text unblocks nothing until consumed.
- Error is not completed: a provider error ends `failed`; reload while working ends `ambiguous`,
  zero redelivery.
- Seeded schedules: crash between append and ACK, duplicate POST, publish failure, two queued
  requests.
- Playwright: pair, send, answer, offline resend without duplicate.
- Targets: accept p95 under 300 ms; idle delivery under 5 s; reply visible within 3 s of the final
  assistant entry persisting.

## Stages

0. Host confirms tldraw-sync facts, token scopes and TLS provisioning.
1. Read-only mirror with pairing: proves the leak boundary first.
2. iPad input with receipts, states and the provenance rule.
3. Optional streaming overlay.

## Alternatives, exclusions, risks

Rejected: Pi RPC or a second client (second control plane); SSH from the iPad (an unrestricted
keyboard).

Not in v1: streaming, images, slash commands, approvals or Stop from the iPad, several devices.

Biggest risks: an allowlist gap or typed secrets leaking; a stolen token steering a shell-capable
orchestrator, bounded by TLS, pairing and provenance, though iPad text stays in later context.

## Open questions

1. TLS: Tailscale Serve or a local CA profile on the iPad?
2. Should a terminal-granted mode ever give iPad turns write tools?
