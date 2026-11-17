# Pi harness

- Read `README.md` for installation and `documentation/architecture.md` for authority and
  persistence.
- This directory owns Pi-specific prompts, roles, runtime, lint profiles and tests. Shared skill
  content is an input. Preserve Codex installation behavior; Claude cleanup belongs in `../claude/`
  and its workers receive explicit prompts from this harness.
- Use `npm ci`, `npm run format`, then `npm run verify`. Run `npm run test:live` when changing model
  integration, delegation, review or context behavior. Run `npm run test:live:workshop` for design
  advice, shell/file authority or workshop lifecycle changes. Live runs use the configured Pi
  credentials.
- The orchestrator has normal host shell and file tools. It workshops designs, saves requested
  document edits directly and handles routine work. Delegate substantial implementation to Astra
  high; Fable 5.2 medium or high supplies independent design advice and specialist reviews.
- Keep trusted policy and receipts outside worker workspaces. Delegated product edits go through
  scoped workers and snapshot-bound verification. Never silently fall back from worker sandboxing.
- Workshop document edits require no acceptance checkpoint, implementation worker or test adapter.
  Preserve workshop conversation; reserve `propose_design` and `/accept-design` for a settled
  implementation handoff. Persist accepted implementation scope before explicit pruning. Preserve
  pending user input. Archived exploration must not re-enter a request through resume, tree
  navigation or compaction.
- Runtime traces belong under the target project’s gitignored `.pi/traces/`; keep them out of worker
  snapshots. The launcher persists local sessions; ordinary Pi sessions are mirrored.
- Keep prompts in `prompts/`, role definitions in `roles/`, and harness validation evidence in
  ignored `reports/`. The installer backs up changed Pi assets and never reads credential contents.
- Preserve exit status, required skips, cancellation and stale evidence as distinct outcomes.
- Benchmarks measure real public behavior. Instrumentation must preserve disabled behavior.
