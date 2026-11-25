[Archived tool payload; complete contents remain in the project session trace.]

# Whiteboard composer and unified Agent canvas

## Authority and priority

The user authorized implementation on separate feature branches, then merge to main, push both
repositories and update local pih once verified. This is primary work. The bidirectional iPad chat
proposal is separate design-only work on design/ipad-chat; do not implement it or mix its documents
into this feature. No routine approvals are needed within this settled scope.

Fable 5.2 provided advice with the actual frontend-design:frontend-design Skill enabled and invoked.
The host chose the safe defaults below. Existing native components, typography and palette remain.

## User experience

One human Sketchboard and ONE Agent canvas. Remove Interpretation/Ideas selectors and do not replace
them with two framed canvases. Agent explanations and questions may share the diagram, including
connections to sketch-derived nodes. The human still owns Sketch; agents never write it directly.

On every iPad view show a beautiful, compact Notify composer: optional multiline text, an Interpret
pressed/unpressed toggle, and one Notify agent button. No separate immediate Interpret send button.
Interpret starts off; its pressed state may remain for this tab after sending. Off + empty text
sends an ordinary sketch notification. On sends a cleanup request, with or without additional text.
Optional text is part of the durable request, not an ACK status message. No full chat transcript in
this scope.

Use a labelled, auto-growing textarea (one to four lines, bounded scrolling), existing Atkinson type
at least 16px, visible focus and at least 44px controls. A ruled note-line is the characterful
element; keep other chrome quiet. Sentence case, no gratuitous icons, fonts, cards or animation.
Reuse Notice, ViewTabs, ViewPanes, CleanedPane/evolved AgentPane, tool strip, tokens and native
tldraw shapes. Adapt portrait/landscape and visualViewport changes for the software keyboard without
jumping the human sketch camera. Replace may wrap to a second row rather than shrink touch targets.
Enter is a newline; Cmd/Ctrl+Enter sends, except during IME composition. Typing d/r/Backspace must
not trigger canvas keys.

Retain a draft on failure and ambiguous delivery. Clear only the exact sent draft after a durable
server echo; if the user edited while sending, retain their newer text. Bound concurrent sends to
one. Do not add a second model, provider or model-per-poll call. Mac stage remains a read-only
presentation surface with pairing access, not an interactive input composer.

Replace sketchboard copies the entire visible Agent document as native editable shapes/bindings,
including agent additions, in one human editor transaction and one undo. Preserve ink on failed
paste.

## Unified document and publication semantics

Use one stored Agent graph, one revision CAS, bounded unified history and one native render store.
Semantic nodes and edges may carry origin sketch|agent. Existing all-sketch cleanup diagrams remain
accepted. Source/agent provenance is metadata with a restrained native rendering distinction if
useful, not separate permanent regions, pages or tabs. Cross-origin graph edges are allowed and
validated.

Interpret means faithful cleanup of the latest source, not speculative expansion. Its prompt retains
stable IDs and existing agent annotations where still meaningful; obsolete attachments become honest
standalone notes rather than dangling edges or silent loss. Additional typed context may guide the
response, but proposals must remain agent-origin, never masquerade as what the person drew. Ordinary
Notify does not itself force cleanup; the host reads/converses and may update the same Agent canvas.

A publication replaces the unified graph atomically with its exact base_revision. Compare the
sketch-origin semantic subgraph with the current one: modifying/removing/adding sketch-origin
elements requires the proposal snapshot to equal the CURRENT sketch hash. Agent-only changes can
publish after continued drawing only when sketch-origin content is unchanged. Preserve the last
interpretation's source hash on agent-only publication, so it remains stale until actually
reinterpreted. A single revision guards all publications; rejected writes leave current
graph/history unchanged. Validate origins, IDs, endpoints, parents, shape counts and complete input
before mutation.

Bound the unified graph at 160 semantic nodes, 320 edges, 800 composed shapes and 1 MiB proposals;
these hold both previous bounded documents with headroom. Keep 8 unified historical revisions and
explicitly validate legacy maxima. No new dependencies. Keep production assertions and ordinary
external-input errors. Prepare/render outside the atomic commit and persist before swapping state.

Migration must be deterministic, crash-safe and non-lossy. Preserve BOTH legacy state files and
their histories verbatim in bounded archives. Current Interpretation and Ideas become visible in one
graph: namespace legacy IDs/bindings to avoid collisions, mark origins, and deterministically offset
legacy Ideas only where necessary to avoid overlap. No permanent two-frame UI. Future agent
publications can weave them naturally. Source hash remains the last Interpretation source. Make
migration idempotent and test failures at each disk boundary. Publish a newer storage format only
after archives are safe; an older daemon must refuse that newer active format instead of silently
replacing current data. Snapshots expose prior unified graph plus archived legacy semantic
information for the agent. Do not read or mutate real personal board data as fixtures.

## CLI/tool protocol shared by both implementers

Preserve current flat JSON success/failure envelopes, owner/session binding and private credentials.
Protocol v2 is explicit; never silently drop text when either side is older.

whiteboard-link gains --protocol 2; success includes protocol:2 plus existing public fields.
whiteboard-poll gains --protocol 2; success includes protocol:2, session,owner,sketch_hash,
agent_revision and outstanding events. pih MUST explicitly pass --protocol 2 on link and poll. For
old callers missing protocol, reject with a stable upgrade_required outcome when the current
workflow cannot be delivered safely. Do not deliver text-bearing requests to a poller without v2.

Events retain id,kind,sketch_hash,created_at_ms,state and add optional text plus request_id. Kinds
remain sketch_notify|interpret_request, set by the Interpret toggle. text is separate from the
existing optional ACK message. Preserve exact Unicode/newlines; no trimming or truncation. Omit
empty text. Bound text at 4000 Unicode code points and the complete request at 16 KiB UTF-8. Reject
NUL and other C0 controls except tab/newline/CR with actionable validation. Validate stored journals
on load. Keep the 64-event capacity, stable event IDs and existing durable ACK ordering. request_id
is a bounded browser-generated UUID used to deduplicate the SAME send across a lost response;
retries reuse it. Return the original durable event on an exact duplicate; reject reuse with
different kind/hash/text. Fresh deliberate sends use fresh IDs even with identical text. Retain the
existing latest event UI. Bound replay retention explicitly; an expired retry must fail visibly
rather than create another wake. A bounded replay ledger or expiring browser request timestamp may
support that guard.

New client must confirm v2 capability from public status BEFORE sending text, and require a response
that echoes the exact stored request_id/kind/hash/text. An old daemon must yield an explicit
restart/ upgrade direction while retaining the draft, not queue a stripped request and show false
success. The link CLI must identify an already-running pre-v2 daemon before reading a nonexistent
issuing key; return upgrade_required rather than generic whiteboard_io. Do not restart a shared
daemon blindly.

whiteboard-snapshot/publish use canonical --layer canvas, defaulting to it if omitted. Snapshot JSON
uses existing
path,records_path,strokes_path,diagram_path,previous_diagram_path,snapshot,base_revision,
session,prompt,publish_command plus unified graph/history metadata as appropriate. Publication
returns session,layer:'canvas',revision. agent_revision is the unified revision, not a separate CAS
token. Legacy interpretation/cleanup commands may alias a deliberate all-sketch cleanup of the
unified graph with fresh CAS/source validation. Legacy Ideas publication must fail with an
actionable migration instruction rather than erase the interpreted graph or recreate a hidden second
canvas. Preserve existing saved histories and documented legacy drawing/session commands.

pih host-only whiteboard snapshot/publish defaults to canvas; accepts the new canonical value,
retains only safe explicit legacy aliases with clear errors if unsupported. ACK/status remain.
Update argument validation, CLI result validation, tool schema, role/prompt/docs and bounded payload
delivery. Verify scope/privacy revivers do not remove legitimate request text. Typed notes are
delimited paired-user requests, not higher-priority system prompts or authorization for
destructive/new out-of-scope work. Pencil/shape content stays untrusted data. No worker tool access
or credentials in model output. Raise the bounded poll stdout budget to 2 MiB for the 64-event
payload. Bound each model wake to 16 events AND 32 KiB of event JSON, deferring remaining events
without starvation or text truncation.

## Verification and rollout

Keep existing required gates. Add deterministic regressions for unified CAS/source protection,
agent-only stale publish, migration/archive/rollback, cross-origin edges, all bounds, text
exactness, request replay, wrong owner/token/session, old-service mismatch and dropped response.
Before/after or negative-control evidence is required for safeguards. Check SDK boundaries for text
reaching the owning host intact, no text loss or extra wake on retry/reload, pending terminal input
and pauses.

Use real Playwright for composer empty/typed/Interpret sends, Unicode/newlines, shortcuts and IME,
draft failure/retry, viewport/keyboard behavior, single canvas, copy-back native bindings/undo and
portrait/landscape geometry. Capture and inspect settled screenshots; avoid hidden tldraw
measurement nodes and use explicit subpixel geometry tolerance, not ratio equality. No
sleeps/network/models in fast tests. Real hosted live integration is a separate host gate. Export
finished evidence privately.

The host owns final paired SDK/CLI/browser E2E, Git commits/merge/push, local pih sync and a
graceful live-daemon upgrade after backup with existing drawing hash/count preserved. Worker cannot
install, change host policy, publish, read credentials or use the live personal board as a fixture.
Do not call work complete on a worker message alone; report exact snapshot checks, gaps and actual
model.
