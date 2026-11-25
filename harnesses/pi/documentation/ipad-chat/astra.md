# A second reading surface, not a second agent

**Recommendation:** Pair the iPad to one live terminal conversation. Start sharing from _here_, not
from the beginning of the session. The terminal user selects which text leaves the Mac; the iPad
reader can ask a follow-up without putting down the Pencil to reach the terminal. Pi handles it in
the owning session. Its ordinary terminal reply is the source of the iPad reply, not a prompt to
invoke another model. Keep Notify for requests about the drawing; chat neither reads pixels nor
writes tldraw records.

## What the source supports

Paths below are relative to `harnesses/pi`. `src/extension.ts` registers whiteboard, delegation,
host work and traces separately. `src/whiteboard.ts` binds `Attachment` to the session and cancels
obsolete listeners. `src/whiteboard-feed.ts` polls every two seconds when healthy, checks
`ctx.hasPendingMessages()` and `hostWorkPaused(ctx)`, and reconciles a flushed current-branch
receipt before ACK. Borrow those rules, not the canvas queue. Neither `TaskFeed` in
`src/delegation-tools.ts` nor the private mirror in `src/traces.ts` is a public transcript.

`src/shell-render.ts` and `src/timing.ts` consume `pi.on('message_end', ...)`; timing also checks
`event.assistantMessageEvent.type === 'text_delta'` inside `message_update`. I inspected the global
`@earendil-works/pi-coding-agent` **1.6.0** `dist/core/extensions/types.d.ts`: `MessageEndEvent`
carries `message: AgentMessage`, not a public string or entry ID. `MessageUpdateEvent` also carries
`assistantMessageEvent`; bundled `@earendil-works/pi-ai/dist/types.d.ts` distinguishes `delta` from
`partial`, which can contain thinking and tool calls. Streaming would shorten the blank wait but
would disclose text before review and complicate reconnect. Show “Working” instead. Host 1.6.1 is
reported, not inspected; `package-lock.json` pins 1.5.2. Verify against that artifact before ship.

## Sharing and authority

Proposed host adapter: while sharing, match interactive typed user input and its settled final
assistant answer to durable entries on the active branch. Copy only literal user text and final
assistant `type: 'text'` blocks, never the enclosing objects. Skip commands, expansions, mixed or
unattributed turns, background wakes, system prompts, reasoning, tool I/O, signatures, credentials,
workers and traces. Even a final answer can quote a secret. Preview the exact bounded projection
locally after masking known secrets; require terminal release or omission before publication. No
filter recognizes every credential. Release in transcript order, using
`ctx.sessionManager.getBranch()` entry IDs, not text equality. No historical backfill or unbounded
review queue: pause sharing when eight entries await review.

Propose `customType: 'ipad-chat-input'`, literal text as `content`, owner/epoch/request ID in
`details`, and `display: true` so the terminal sees the question once. At idle use
`pi.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' })`, as `BoardFeed` does; wait
through busy turns, terminal input or explicit pause. Never inject keystrokes, call a command parser
or expand templates. Reject files, control sequences and empty input. Remote turns are answer-only:
deny tool execution, delegation and host mutations at dispatch, including indirect calls. Fail
closed if turn provenance cannot be enforced. Destructive work needs fresh explicit terminal
authority; a later “yes” on the iPad cannot grant it.

## Proposed contract

```text
Submit(epoch, device, counter, text) -> Request(id, status)
Read(epoch, afterSeq) -> ordered Change(seq, requestStatus | publicMessage | gap)[]
publicMessage = (entryId, role, text, truncated, requestId?)
```

Keep chat in a private Mac journal behind separate authenticated routes. The bound loopback adapter
polls for work and upserts released entries by `(epoch, entryId)`. Journal order, not device time,
drives replay. One writer lease, one outstanding counter per device; two tabs racing the same
counter get the existing result for identical bytes or conflict otherwise. Persist the high-water
mark through expiry; reject stale counters even after bodies age out. A second device reads until
the terminal transfers the lease. Replace the composer's pending row by request ID when its entry
arrives; never append a second echo or deduplicate distinct questions by text alone.

Accepted means committed on Mac; queued means waiting for host eligibility. Persist claim before
wake; working requires the matching session receipt. Completed requires a correlated settled reply
(release or explicit “reply withheld”); failed means known rejection or failure. A dropped ACK
replays status, not the prompt. Crash between claim and proven receipt, or uncertain response
association: mark ambiguous, never auto-invoke again. Exactly-once display by stable ID is possible;
exactly-once model execution across two stores is not. Cancel only before claim, atomically. Stop,
switch, fork or tree change fences old requests and cursors by generation; never adopt another
branch. Resume only after proving owner and lineage, otherwise re-pair.

Limit input to 4 KiB UTF-8, reply to 32 KiB (mark truncation), eight queued requests, one in flight.
Keep at most 256 changes, 1 MiB or 24 hours, whichever comes first; reserve live request slots
separately. Expired cursor returns a bounded current window marked “Earlier messages expired.”
Reject overload before acceptance; no offline auto-send. After timeout retry the same ID only. Batch
up to 16 changes (64 KiB) per read; allow one poll in flight and stop after five consecutive
failures until explicit reconnect. Keep the cursor, not a second browser transcript.

The supplied board design leaves canvas sync unauthenticated. Use a distinct trusted HTTPS chat
origin, not plain LAN HTTP or a bearer shared with the drawing. Open the drawing inside the trusted
chat layout only on a separate HTTPS origin; otherwise use separate tabs. Never pass chat data to
the canvas frame. Terminal QR exchanges a one-use fragment within 60 seconds for a revocable
eight-hour board/owner/epoch read or writer session; clear the fragment. Use host-only Secure,
HttpOnly, SameSite=Strict cookies, exact Origin and CSRF checks on writes, no cross-origin reads or
caching. Never send the mode-0600 host binding to the browser (`src/whiteboard-cli.ts`). Revoke on
detach; fail closed without trusted TLS.

## At the drawing board

```text
[Draw] [Chat · 1]     Owner: current terminal
You · iPad     Which dimension changed?
Assistant      The opening is wider by 20 mm.
[Ask this terminal…                     ] [Send]
```

Use the supplied ViewTabs, Notice, vellum palette and bundled Atkinson face. Landscape: collapsible
side pane; portrait: separate reading sheet preserving canvas zoom and Pencil strokes. Isolate pen
gestures from selectable, wrapping, copyable text. Render text nodes, not HTML or active links. Keep
scroll position when reading older replies. Large Send target; Return inserts newline,
Command-Return sends. Offline, read-only or full: explain disabled Send and keep the draft in
memory. Retry a lost submission, not an ambiguous turn.

## Build gates and open questions

Ship disabled by default: negotiate chat capability, pair and test read-only release first, then
enable one writer. Old CLI/boards keep drawing. Extend `tests/session-support.ts` capture-provider
sessions and `tests/whiteboard-recovery.test.ts` seeded schedules: crash around claim/receipt,
duplicate ACK, fork during publish, terminal preemption, forbidden tool call and secret canaries.
Assert one owner invocation on normal retry, zero on stale claims, no private bytes on the wire.
Playwright: two tabs, draw, send, disconnect after acceptance, reconnect, copy one reply, revoke.
Count queue depth, conflicts, ambiguity and release-to-visible latency without bodies; target p95
under three seconds on healthy LAN, excluding review/model time. Can deployment supply trusted TLS,
and can pinned Pi prove input provenance and dispatch isolation? Gate writing on both. No remote
shell, token stream, second provider, cloud relay or canvas transcript in v1.
