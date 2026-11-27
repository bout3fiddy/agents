# Whiteboard integration check

tldraw-sync owns the composer, read-only stage, canvas revision and Sketchboard undo. pih links and
polls with `--protocol 3`. Three parties hold a protocol number: the pih launcher, the tldraw-sync
CLI and the running daemon, which keeps the protocol it was started with until it restarts. A
mismatch reports all three, for example
`pih requests 3, the tldraw-sync CLI supports 3, the daemon reports 2`. `tldraw-sync stop` saves the
board before stopping; the next `/start_whiteboard` starts the current daemon and reopens the same
binding. Do not stop a daemon another session is using without telling its owner. Keep binding files
private; never inspect or paste their contents.

On the Mac host with the reviewed tldraw-sync executable and a **disposable** project, run from
`harnesses/pi`:

```sh
PI_WHITEBOARD_BIN=/path/to/tldraw-sync npx --no-install tsx tests/whiteboard-live.ts \
  /path/to/disposable/project whiteboard-smoke-pairing
```

The driver checks reopen identity, protocol negotiation, poll ownership, readable snapshot
artifacts, that a preview publishes nothing and that a publish saves the previewed records. It opens
a stage and leaves the board running. To check delivery end to end:

1. Launch pih in the disposable project. Run `/start_whiteboard` twice. Scan the QR on the stage;
   confirm the second link reopens the same drawing. Leave the stage open.
2. Draw on the iPad. Tap **Send** with an empty note. Then enter a multiline Unicode note asking for
   something drawn and send again. Queue a terminal follow-up; confirm it goes first. Check both
   requests reach only this session as `sketch_notify`, with exact text separate from ACK status.
   The first is answered in conversation and publishes nothing; the second is drawn.
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
