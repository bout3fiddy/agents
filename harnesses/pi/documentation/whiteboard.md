# Whiteboard integration check

tldraw-sync owns the composer, read-only stage, canvas revision and Sketchboard undo. pih links and
polls with `--protocol 2`. A mismatch requires a coordinated upgrade; do not restart a shared daemon
blindly. Keep binding files private; never inspect or paste their contents.

On the Mac host with the reviewed tldraw-sync executable and a **disposable** project, run from
`harnesses/pi`:

```sh
PI_WHITEBOARD_BIN=/path/to/tldraw-sync npx --no-install tsx tests/whiteboard-live.ts \
  /path/to/disposable/project whiteboard-smoke-pairing
```

The driver checks reopen identity, v2 negotiation, poll ownership and readable canvas artifacts. It
opens a stage and leaves the board running. To check delivery end to end:

1. Launch pih in the disposable project. Run `/start_whiteboard` twice. Scan the QR on the stage;
   confirm the second link reopens the same drawing. Leave the stage open.
2. Draw on the iPad. Tap **Notify agent** with an empty note. Then enter a multiline Unicode note,
   turn on **Interpret** and notify again. Queue a terminal follow-up; confirm it goes first. Check
   both requests reach only this session, with exact text separate from ACK status. The first need
   not change the canvas; the second should faithfully clean up the sketch without replacing ink.
3. Snapshot and publish with `layer: canvas` or omit the layer. Use the full Agent graph and exact
   base revision. Add an agent-origin question while continuing to draw. The unchanged sketch-origin
   graph should remain stale. Race a sketch-origin edit against new ink; it must not publish. A
   legacy Ideas publication must fail without changing the canvas. As the human, replace Sketch,
   check the native shapes and connections are editable, then undo the replacement once.
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
