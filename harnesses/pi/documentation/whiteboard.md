# Whiteboard integration check

tldraw-sync owns the composer, read-only stage, the agent print revision and Sketch undo. pih links
and polls with `--protocol 4`. Three parties hold a protocol number: the pih launcher, the
tldraw-sync CLI and the running daemon, which keeps the protocol it was started with until it
restarts. A mismatch reports all three, for example
`pih requests 4, the tldraw-sync CLI supports 4, the daemon reports 3`. `tldraw-sync stop` saves the
board before stopping; the next `/start_whiteboard` starts the current daemon and reopens the same
binding. Do not stop a daemon another session is using without telling its owner. Keep binding files
private; never inspect or paste their contents.

## Native and legacy boards

`/start_whiteboard` links a new board as native (`whiteboard-link --native`);
`/start_whiteboard legacy` links a new legacy board. pih records the mode with the link in the
session. An existing board keeps its mode: a link recorded before native boards existed is legacy,
reload reattaches without relinking, and a start naming the other mode is refused before the CLI
runs. A native link must echo `native: true`; a CLI that omits it cannot confirm the board and is
rejected. A legacy link of a binding with no recorded mode is refused, because a link without
`--native` keeps whatever the binding is. The CLI itself refuses `--native` on a legacy binding;
nothing is migrated.

A native board has two tool actions besides `status` and `ack`:

- `scene` runs `whiteboard-scene` and returns `session`, `base_sequence`, `records_count` and the
  absolute private `scene_path` artifact (`{session, base_sequence, records, hashes}`).
- `edit` runs `whiteboard-edit --file` with one edit file:
  `{base_sequence, adds, updates, deletes, request_id?}`. All three arrays are required; unused ones
  are empty. Adds are full records with placeholder ids (`shape:new-…` or `binding:new-…`); updates
  are `{record, base_hash}` with the original id; deletes are `{id, base_hash}`. Every operation
  names a distinct record. pih checks the released bounds first (at most 1 MiB + 4 KiB, 1 to 800
  operations, 64 lowercase hex `base_hash`, `request_id` matching `^[A-Za-z0-9_-]{8,64}$`) and
  leaves deeper record checks to the CLI. The reply must name `edit_written`, `edit_replayed` or
  `edit_unchanged`, its matching `result`, the request ID (by default `file-` and the first 40 hex
  characters of the file's SHA-256), a sequence (null when unchanged) and the minted ids.

Each edit is one atomic change and one ordinary iPad undo step; pih has no revert. A conflict
(exit 5) or a named rejection (exit 1) settles the edit: read the scene again and write a new one.
Any other failure leaves the outcome unknown, and pih then accepts only the identical file until a
fresh scene read. pih never rebases or retries an edit itself. Snapshot, preview, controls and
publish belong to legacy boards; scene and edit are refused on them, and the reverse.

The host-run check `native-board-disposable-cli` runs `tests/whiteboard-native-live.ts` against an
expendable copy of the released CLI with a private HOME, TMPDIR, BOARD_DATA_DIR and daemon on
port 0. It links, reads, writes, replays, edits in place and conflicts on a native board; links a
legacy board, checks its binding is unchanged and that native link, scene and edit are refused; then
runs both modes through a Pi session. It stops only its own daemon.

## One canvas

On a legacy board, Sketch and the agent print are layers of one dotted surface that share one
camera; there is no other view to switch to. The human editor owns Sketch: pih has no action that
writes it. `publish` owns the agent print and replaces it whole with the previewed scene file,
guarded by the agent print revision and the sketch hash. The snapshot image is a composite of both
layers, so it never shows which pixels are human ink; the host checks the snapshot's saved original
agent records for provenance and completeness. Only the human can inspect a printed shape and take
it into Sketch, as one edit that one undo reverses. This changes no tool action and no protocol 4
field.

## Authoring capabilities and selected state

The snapshot is the board's own description of what a scene may contain: its `prompt`,
`capabilities`, `capabilities_path`, `scene_controls`, `states_count` and artifact paths reach the
host unchanged. pih restates no board schema; it checks only that every `*_path` field is a usable
path, that `states_count` is a positive integer or null, and that no credential-like key appears.

`preview` alone may take `controls`, an object mapping named control ids to option values. pih
checks the board's bounds (0 to 8 controls, ids matching `^[A-Za-z][A-Za-z0-9_-]{0,39}$`, options
matching `^[A-Za-z0-9_-]{1,40}$`, at most 1024 bytes of JSON) and passes the map unchanged as one
`--state` JSON argv value. Any `controls`, even `{}`, request the `selected` view; the board
completes omitted controls with their resting values. A preview without `controls` sends exactly the
earlier argv and requests the `rest` view.

Every preview reply must say `published: false`. The protocol 4 CLI also names the view it drew. A
rest request accepts:

- `view: 'rest'` with the completed resting `state` (`{}` for a scene without controls) and a
  positive `states_count`;
- `view: 'rest'` with `state: null` and `states_count: null` from a daemon without selected state;
- none of `view`, `state` or `states_count`, from an older CLI.

A selected request accepts only `view: 'selected'` with the completed `state` and a positive
`states_count`.

A reply naming the other view, a partial set of these fields, or a `state` that disagrees with a
requested control is rejected. pih returns the validated `view`, `state` and `states_count` to the
host. `controls` on any other action, and ACK fields (`event`, `state`, `message`) on a preview or
publish, are rejected before the CLI runs. `publish` never takes `--state`; it saves the canonical
scene, which is the rest view.

## Private chat

Every request is a `sketch_notify`. Protocol 4 adds an optional boolean `include_sketch`: absent or
`true` is a sketch request; `false` is a private text chat and must carry `text`. pih rejects the
whole poll for any other value or a chat without text, and hands the host `include_sketch` as an
explicit boolean. The listener only polls and records receipts; it never fetches the sketch. The
host answers a chat without a snapshot, preview or publication.

The host answers on the board through the existing ACK. `working` carries no message and is not the
answer. `updated` or `failed` finishes the event with `--message`: the answer the person reads, 1 to
4000 Unicode code points (always within 16 KiB of UTF-8), passed as one exact argv value. pih
rejects a missing, blank, option-like, oversized or control-bearing answer instead of trimming or
clipping it. An ACK must name an event outstanding on this board and delivered on this conversation
branch, so each request gets one answer and no foreign, finished or future event is answered. The
answer is written for the person; the host transcript, tool and CLI output are never streamed.

On the Mac host with the reviewed tldraw-sync executable and a **disposable** project, run from
`harnesses/pi`:

```sh
PI_WHITEBOARD_BIN=/path/to/tldraw-sync npx --no-install tsx tests/whiteboard-live.ts \
  /path/to/disposable/project whiteboard-smoke-pairing /path/to/controlled-scene.json theme=dark
```

The controlled scene is a synthetic template with at least two controls in the snapshot scene
format; `control=option` names a non-resting option of one. The driver writes the template onto the
board's basis (the snapshot scene's scalar fields) in the disposable project. It checks reopen
identity, protocol negotiation, poll ownership, readable snapshot and capabilities artifacts, the
empty canvas's rest preview (`state: {}`, `states_count: 1`), the controlled scene's rest view and a
partial selected view completed at rest, that no preview publishes and that a publish saves the rest
records, not the selected ones. It opens a stage and leaves the board running. Use a disposable
`BOARD_DATA_DIR` and CLI copy.

The private chat journey runs a real Pi session with a scripted host against the real CLI on a new
temporary project and board. Prerequisites: a tldraw-sync CLI and daemon that both speak protocol 4
with the private chat composer, and an iPad or browser on the same trusted LAN. From `harnesses/pi`:

```sh
PI_WHITEBOARD_BIN=/path/to/tldraw-sync node --import tsx tests/whiteboard-chat-live.ts
```

Open the printed iPad URL, turn off sharing the sketch, type a note and send it within ten minutes.
The driver answers that chat once with a fixed Unicode message, checks that a second answer is
refused, that the event is no longer outstanding and that nothing snapshotted, previewed or
published. Confirm the answer appears beside the note on the iPad. It prints the temporary project;
delete it afterwards. It never touches another board.

To check delivery end to end:

1. Launch pih in the disposable project. Run `/start_whiteboard` twice. Scan the QR on the stage;
   confirm the second link reopens the same drawing. Leave the stage open.
2. Draw on the iPad. Tap **Send** with an empty note. Then enter a multiline Unicode note asking for
   something drawn and send again. Queue a terminal follow-up; confirm it goes first. Check both
   requests reach only this session as `sketch_notify`, with exact text separate from ACK status.
   The first is answered on the board and publishes nothing; the second is drawn. Then send a
   private note without the sketch: confirm one natural answer appears for it on the board, that no
   snapshot was taken, and that the working ACK alone showed no answer.
3. Snapshot, edit the scene file, preview it and inspect the image; confirm the agent print revision
   did not move. Publish the same file and confirm the print shares the Sketch camera on one
   surface. Race a sketch-basis scene against new ink; it must not publish. As the human, inspect a
   printed shape and take it into Sketch, check it is an editable native shape, then undo once and
   confirm Sketch is as before.
4. Reload pih. Confirm delivered requests do not wake it again. Close the stage and request a new
   snapshot; confirm a tool error rather than a successful publication. Reopen the stage with
   `/start_whiteboard` and verify recovery. Fork or start a new session: no access without a start.
5. Run `/stop_whiteboard` and queue another request. Confirm the board remains available and this
   session does not wake. Restart in the owning session and inspect the outstanding request.

The fast SDK checks use a capture provider, manual clock and replaceable CLI. Replay a recovery
schedule from `harnesses/pi`:

```sh
PI_WHITEBOARD_SEED=24301 npx --no-install tsx --test tests/whiteboard-recovery.test.ts
```
