# Whiteboard integration check

tldraw-sync owns the composer, read-only stage, canvas revision and Sketchboard undo. pih links and
polls with `--protocol 4`. Three parties hold a protocol number: the pih launcher, the tldraw-sync
CLI and the running daemon, which keeps the protocol it was started with until it restarts. A
mismatch reports all three, for example
`pih requests 4, the tldraw-sync CLI supports 4, the daemon reports 3`. `tldraw-sync stop` saves the
board before stopping; the next `/start_whiteboard` starts the current daemon and reopens the same
binding. Do not stop a daemon another session is using without telling its owner. Keep binding files
private; never inspect or paste their contents.

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
  /path/to/disposable/project whiteboard-smoke-pairing
```

The driver checks reopen identity, protocol negotiation, poll ownership, readable snapshot
artifacts, that a preview publishes nothing and that a publish saves the previewed records. It opens
a stage and leaves the board running.

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
3. Snapshot, edit the scene file, preview it and inspect the image; confirm the canvas revision did
   not move. Publish the same file. Race a sketch-basis scene against new ink; it must not publish.
   As the human, replace Sketch, check the native shapes are editable, then undo the replacement
   once.
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
