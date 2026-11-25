# Whiteboard integration check

The button, stage renderer, layer compare-and-swap and Sketchboard undo belong to tldraw-sync. Its
CLI uses flat JSON envelopes. Keep binding files private; never inspect or paste their contents.

On the Mac host with the reviewed tldraw-sync executable and a **disposable** project, run from
`harnesses/pi`:

```sh
PI_WHITEBOARD_BIN=/path/to/tldraw-sync npx --no-install tsx tests/whiteboard-live.ts \
  /path/to/disposable/project whiteboard-smoke-pairing
```

The driver checks reopen identity, poll ownership and readable snapshot artifacts on both layers. It
opens a stage and leaves the board running. It does not test the iPad buttons. To check delivery end
to end:

1. Launch pih in the disposable project. Run `/start_whiteboard` twice. Scan the QR on the stage;
   confirm the second link reopens the same drawing. Leave the stage open.
2. Draw on the iPad. Queue **Notify agent** and **Interpret sketchboard** while discussing another
   task. Queue a terminal follow-up; confirm it goes first. Confirm both requests reach this session
   and only the interpretation request produces a faithful, editable Interpretation. Inspect their
   terminal states on the iPad. Neither request should replace human ink.
3. Add an Ideas proposal while continuing to draw. Race an Interpretation proposal against new ink;
   the stale interpretation must not publish. Replace sketchboard as the human and undo it once.
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
