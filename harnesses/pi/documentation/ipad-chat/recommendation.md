# Recommendation: an iPad companion to the same conversation

Design only. No chat transport or transcript UI has been implemented. The Notify composer and
unified Agent canvas are separate work on `feat/whiteboard-composer`.

## The proposed experience

Pair the iPad with one pih conversation. Open Chat beside the drawing in landscape, or as a reading
sheet in portrait. Show the conversation's user-facing text and let the iPad send a text question.
The same owning orchestrator answers; neither the board nor the iPad starts another model session.
Keep the Sketchboard mounted so opening Chat never resets Pencil strokes, zoom or undo.

Reuse the existing type, palette, notices and composer controls. Use readable speaker labels and
selectable, wrapping text rather than putting chat into tldraw shapes. Enter inserts a newline;
Cmd/Ctrl+Enter sends, matching the Notify composer and respecting IME composition. Preserve reading
position when new replies arrive. Do not auto-scroll someone reading older text.

## What the two designers recommend

- [Astra 6.2](astra.md), high effort: start with terminal-released final-text mirroring, then add
  authenticated, answer-only iPad input. It emphasizes transcript privacy, ambiguous recovery,
  explicit authority and a distinct trusted chat origin.
- [Fable 5.2](fable.md), high effort, with the frontend-design skill: start with an opt-in
  projection of final messages, then add receipted input through the existing custom-message
  delivery path. It emphasizes one request at a time, durable correlation and read-only remote
  turns.

They agree on one conversation, no second provider, explicit pairing, no raw trace mirroring,
bounded storage and queues, final replies before streaming, and staged delivery. Their detailed
security, input and presentation choices are recommendations, not already agreed requirements.

## Host recommendation and meaningful differences

Use automatic mirroring of **new user-facing messages after explicit session opt-in**, not a release
approval for every message. Astra's per-message review is safer for sensitive sessions but too much
friction for the requested companion experience; offer a pause/sharing control and make historical
backfill a separate explicit action. Filtering cannot guarantee a final answer contains no secret.

Publish only literal user text and final assistant text from the active branch. Exclude system
prompts, reasoning, tools/results, worker conversations, private custom events and credentials.
Represent attachments as a count in the first version. Render text safely, without executable HTML.
Require authenticated, encrypted chat transport before sharing real coding conversations. Prefer an
isolated chat origin rather than assuming the existing unauthenticated drawing surface is a safe
place for transcripts. TLS provisioning remains a real deployment decision, not an implicit feature
of the current LAN board.

Start remote input in an answer-only mode, with narrowly scoped read tools if explicitly enabled. Do
not let an iPad message approve shell execution, Git publication, destructive actions or expanded
worker permissions. Enforce authority per correlated request, not solely from the last input source:
Fable's proposed sticky read-only state must not strand already-authorized terminal background work.
A later write-capable mode would require a separate explicit terminal grant and additional tests.

## Smallest complete journey

1. Opt in, pair one iPad, and mirror one newly settled user/assistant exchange. Validate privacy
   canaries and revocation before adding input.
2. Send one text question, persist its acceptance, append one durable custom-message receipt to the
   owning session, and return the correlated final answer to the iPad.
3. Disconnect after acceptance and reconnect: display the same request and answer without another
   model invocation. Preserve ambiguous outcomes rather than silently resubmitting.

Use stable entry/request IDs, a generation/epoch fence for session and tree changes, cursor-based
replay and an explicit expired-window response. The daemon owns the public journal; the pih session
owns proof of delivery and the answer. Exactly-once display is feasible; do not promise exactly-once
model execution across a crash between independent stores.

Suggested initial limits: 4 KiB input, 32 KiB final replies, eight pending requests, one active
request, and a 256-record/1 MiB/24-hour transcript window. Bound replay tombstones separately.
Terminal messages and explicit pauses take priority. Reject overload visibly and preserve drafts on
failure. Do not silently truncate a request or replay an expired submission as new work.

## Evidence and remaining decisions

Both drafts are separately attributed. Fable checked pinned SDK 1.5.2 declarations directly after
the host supplied them. Astra checked 1.6.0 and correctly marked the pinned version as unverified;
the host subsequently confirmed the relevant 1.5.2 message/input declarations. This is source
evidence, not proof that a provenance gate or crash recovery implementation works.

Before a build, choose TLS provisioning and confirm answer-only input meets the desired first
version. Then require capture-provider SDK tests, leak and forbidden-tool negative controls, seeded
recovery schedules, and a real paired-browser journey covering reconnect, two-tab races, keyboard,
revocation and retained drawing state. Streaming, remote approvals, attachments and multiple writer
devices stay out of the first version.
