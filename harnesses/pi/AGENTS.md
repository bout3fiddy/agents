# Pi harness

- Read `README.md` for installation and `documentation/architecture.md` for authority and
  persistence.
- This directory owns Pi-specific prompts, roles, runtime, lint profiles and tests. Shared skill
  content is an input. Preserve Codex installation behavior; Claude cleanup belongs in `../claude/`
  and its workers receive explicit prompts from this harness.
- Use `npm ci`, `npm run format`, then `npm run verify`. Run `npm run test:live` for implementation
  and review workflow changes, `npm run test:live:delegation` for background task changes,
  `npm run test:live:workshop` for design advice, shell/file authority or workshop lifecycle
  changes, and `npm run test:live:web` for Claude web tools and research prompts. Live runs use the
  configured provider credentials.
- The automated test runner uses four concurrent files to bound simultaneous SDK fixtures and
  subprocess trees. This test-resource setting does not limit production branch orchestration.
- For independent branch execution, read `documentation/branches.md` and run
  `npm run test:live:branches`; `-- --github OWNER/REPO` also exercises real GitHub PRs and CI in an
  empty private fixture. Never use an active assignment repository as a destructive fixture.
- The orchestrator has normal host shell and file tools. It workshops designs and makes small, quick
  edits directly. Honor explicit delegation and send lengthy work to background task coordinators
  while discussion continues. Delegate substantial implementation to Astra high; Fable 5.2 medium or
  high supplies independent design advice and specialist reviews.
- Keep trusted policy and receipts outside worker workspaces. Delegated product edits go through
  scoped workers and snapshot-bound verification. Never silently fall back from worker sandboxing.
- Workshop document edits require no acceptance checkpoint, implementation worker or test adapter.
  Preserve workshop conversation; reserve `propose_design` and `/accept-design` for a settled
  implementation handoff. Persist accepted implementation scope before explicit pruning. Preserve
  pending user input. Archived exploration must not re-enter a request through resume, tree
  navigation or compaction.
- Deliver consultation results once at the next safe model/tool boundary. Persist consumption for
  late waits, discard obsolete automatic delivery after newer user input, and preserve raw advice.
  Test delivery with actual Pi runtime events; boundary messages emit `entry_appended`.
- Keep routine decisions within the orchestrator; delegate lengthy document work or explicit
  delegation requests. Use `document_check` for Markdown formatting, bounded consultation excerpts,
  and concise independent advice. Preserve user constraints and exact raw traces when excerpting
  historical tool payloads from working context.
- Record actual model/effort and request/model/tool timing under project-local `harness/timing/`.
  Respect the selected orchestrator model; implementation remains independently pinned to Astra
  high.
- Runtime traces belong under the target project’s gitignored `.pi/traces/`; keep them out of worker
  snapshots. The launcher persists local sessions; ordinary Pi sessions are mirrored.
- Keep prompts in `prompts/`, role definitions in `roles/`, and harness validation evidence in
  ignored `reports/`. The installer backs up changed Pi assets and never reads credential contents.
- Preserve exit status, required skips, cancellation and stale evidence as distinct outcomes.
- Benchmarks measure real public behavior. Instrumentation must preserve disabled behavior.
- Background task processes survive reload and session exit. Keep project-wide file reservations,
  bounded coordinator children, scoped steering/cancellation, and per-task private evidence. Deliver
  completion once at a safe boundary and wake an idle orchestrator for a brief acknowledgement.
  Batch simultaneous results and prioritize queued user input. Test against the real Pi SDK.
- Apply document candidates only after scope, format, control revision and changed-file conflict
  checks. Maintenance code also requires final specialist review and executable project checks.
  Never replace a pending integration journal. Keep subprocess cancellation bounded and propagated.
- Route multi-file or lengthy document changes before patch generation. The direct-edit guard
  permits one file, two calls, 2 KB of combined old/new text and four model steps per user request.
  Keep shell reads available; reject common document-rewriting bypasses. Exercise natural user
  requests without tool names in live delegation tests.
- Capture runtime source identity at module load. Record startup/reload IDs, reasons and actual tool
  inventories under project-local `harness/runtime/`; attach the load ID to request timing. Never
  report a newer disk revision as the version already loaded in a process. Keep role/prompt policy
  fixed for that loaded generation. `/harness-version` must show this receipt without a model call.
- `delegate_branches` pins a settled committed design and remote-main baseline for up to four
  independent tasks. The branch orchestrator owns its implementation/review/repair cycle and needs
  no routine human approvals. It has no child-call, turn or total-duration ceiling. Keep explicit
  cancellation, bounded command execution, scopes and concurrency controls. Local task-coordinator
  budgets remain unchanged.
- Keep Git and publication authority in the host. Branch workers cannot edit Git metadata or project
  policy. Verify committed blobs against the reviewed snapshot, retain separate remote branches and
  GitHub PR/CI evidence, and serialize merge-time refresh against current main. Never force-push
  main or bypass remote protection. Preserve the user's checkout and unrelated files. Persist
  failures and worktrees for inspection; a reviewer summary alone never establishes a successful
  merge.
- Branch publication defaults to stopping at `published`. Only an explicit user merge request may
  set `mergeToMain` or invoke `merge_branches`. Persist that authority; reuse the task's worktree
  and send separate publication/merge notifications. Race-test authorization at the publication
  boundary.
- On authorized merges, discover automated GitHub reviewers and triage their findings through the
  branch orchestrator. Commit/push verified fixes and observe the next review, at most five external
  rounds. Skip absent reviewers; use adaptive waits for detected work. Persist round counts and
  comment versions, resume interrupted repairs, and retain normal required CI/protection gates. Keep
  this five-round merge policy separate from uncapped implementation orchestration.
