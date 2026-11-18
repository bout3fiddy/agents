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
- Run `npm run test:live:host` for host/delegation routing and `npm run test:live:recovery` for
  pause, scope reassignment and resumption. These fixtures use disposable projects and preserve
  their reports under `reports/`; never use active user work as an interruption test fixture.
- Run `npm run test:live:workers` for live conversation, guidance or worker hierarchy changes. Use
  `scripts/check-workers-terminal.py` as documented in README for actual CLI navigation and layout.
  Keep viewing separate from session switching, cancellation and resumption. Group coordinator
  children and related reviews; retain completed ancestors as context when needed. Show delivery
  state honestly and preserve the exact guidance text and immutable worker scope.
- The orchestrator has normal host shell and file tools. It workshops designs and makes small, quick
  edits directly. Honor explicit delegation and send lengthy work to background task coordinators
  while discussion continues. Delegate substantial implementation to Astra high; Fable 5.2 medium or
  high supplies independent design advice and specialist reviews.
- Keep trusted policy and receipts outside worker workspaces. Delegated product edits go through
  scoped workers and snapshot-bound verification. Never silently fall back from worker sandboxing.
- Workshop document edits require no acceptance checkpoint, implementation worker or test adapter.
  Preserve workshop conversation and pending user input. `workflow` takes a settled design when the
  user requests implementation, records its scope and starts work without a separate acceptance
  command. Scope snapshots must not reset sessions or filter host/advisor conversation by date. Keep
  normal Pi compaction and tree navigation; preserve compatibility with stored worker scope.
- Deliver consultation results once at the next safe model/tool boundary. Persist consumption for
  late waits, discard obsolete automatic delivery after newer user input, and preserve raw advice.
  Test delivery with actual Pi runtime events; boundary messages emit `entry_appended`.
- Keep routine decisions within the orchestrator; delegate lengthy document work or explicit
  delegation requests. Use `document_check` for Markdown formatting, bounded consultation excerpts,
  and concise independent advice. Preserve user constraints and exact raw traces when excerpting
  historical tool payloads from working context.
- Honor root `.prettierignore` in document tools and document integration checks. Report skipped
  formatting separately; retain the independent line-width check and path protections. Do not load
  executable project formatter configuration. Use the same pinned Prettier options for Markdown code
  fences, source formatting and the document integration gate.
- For scoped verification, report inherited width findings on byte-identical out-of-scope Markdown
  excluded by the unchanged baseline formatting policy. Keep full checks on added, edited or
  assigned files and provide the complete snapshot to project checks.
- Record actual model/effort and request/model/tool timing under project-local `harness/timing/`.
  Respect the selected orchestrator model; implementation remains independently pinned to
  `openai-codex/gpt-6.2-astra` at high effort.
- Runtime traces belong under the target project’s gitignored `.pi/traces/`; keep them out of worker
  snapshots. The launcher persists local sessions; ordinary Pi sessions are mirrored.
- Keep prompts in `prompts/`, role definitions in `roles/`, and harness validation evidence in
  ignored `reports/`. The installer backs up changed Pi assets and never reads credential contents.
- Preserve exit status, required skips, cancellation and stale evidence as distinct outcomes.
- Benchmarks measure real public behavior. Instrumentation must preserve disabled behavior.
- Background task processes survive reload and session exit. Keep project-wide file reservations,
  scoped coordinator children, steering/cancellation, and per-task private evidence. Deliver
  completion once at a safe boundary and wake an idle orchestrator for a brief acknowledgement.
  Batch simultaneous results and prioritize queued user input. Test against the real Pi SDK.
- Apply document candidates only after scope, format, control revision and changed-file conflict
  checks. Maintenance code also requires final specialist review and executable project checks.
  Never replace a pending integration journal. Keep subprocess cancellation bounded and propagated.
- Choose direct work or delegation from context, complexity and disruption. Routine setup and
  related edits may stay on the host; substantive implementation, explicit delegation and
  distracting lengthy work go to workers. No direct-edit file/byte/call quota exists. Simple setup
  does not need Fable review. Required checks still apply; specialist review follows actual risk or
  user requests.
- Inspect host/worker capabilities before dispatch. Workers cannot install dependencies, retain
  shell-generated lockfiles, configure host policy or publish Git. Handle authorized host operations
  directly, reject incompatible declared requirements, and use structured hostActions for handoff.
  Inspect and recover retained work instead of repeating an incapable worker. Never resume explicit
  user cancellation without a new request.
- Workers use project_edit for focused existing-file changes. Preserve exact text, reject ambiguous
  matches and enforce the same scope/private-path/symlink controls as full writes.
- Persist child/tool progress and emit periodic context updates without new model turns. Emit one
  attention notice when activity is absent, inspect the cause, and recover within original
  authority. Silence alone never cancels work. Test progress delivery and reload deduplication with
  the real SDK.
- Keep internal progress messages hidden from the user. Worker-authored summaries describe
  meaningful findings, phases or blockers; telemetry remains automatic. Guidance requests are
  exceptional and identify a concrete missing decision or capability. `/workers` exposes live status
  and optional metadata without flooding the orchestrator conversation.
- Surface meaningful project milestones through one brief host summary at a safe boundary. Batch
  related outcomes, preserve pending user input, and deduplicate across reload. Routine worker
  activity stays private. Keep only the latest routine progress per task in model context. Preserve
  raw receipts, substantive notices and progress from a later resumption.
- Keep later specialist reviews with the coordinator instead of blocking leaf acceptance on them.
  Completion diagnostics must identify the outstanding role and write scope. Require matching-scope
  clearance and reuse passing reviews when the candidate is unchanged.
- Pause affected tasks before scope reassignment. Keep paused paths reserved, preserve candidate
  edits, and revise assignments as a recoverable batch before resuming with fresh context. Reject
  conflicts and scope expansion. Invalidate approvals after revisions. Published branch ownership
  stays fixed; use replacement tasks for changed branch ownership. Test process stopping, retained
  edits, recovery and notification delivery across resume.
- Branch task-workers may retain .md, .txt and .rst only. Validate exact assignments before dispatch
  and enforce the same restriction at the file tool for wildcard scopes. Route project manifests to
  the implementer and keep harness verification evidence host-owned.
- Capture runtime source identity at module load. Record startup/reload IDs, reasons and actual tool
  inventories under project-local `harness/runtime/`; attach the load ID to request timing. Never
  report a newer disk revision as the version already loaded in a process. Keep role/prompt policy
  fixed for that loaded generation. `/harness-version` must show this receipt without a model call.
- `delegate_branches` pins a settled committed design and remote-main baseline for up to four
  independent tasks. The branch orchestrator owns its implementation/review/repair cycle and needs
  no routine human approvals. It has no child-call, turn or total-duration ceiling. All agents
  follow this uncapped policy. Keep explicit cancellation, bounded command execution, scopes and
  concurrency controls; turn counts are telemetry only.
- Local implementation uses one project checkpoint and reserves local writes exclusively. On
  dispatch and resume, distinguish that reservation from overlapping paths and from a full
  background queue. Route new independent builds through branch worktrees when their design and
  checks are available.
- Reject unsupported asterisk patterns before dispatch. Preserve existing literal reservations on
  resume and prompt-only revisions. A revision that omits writePaths keeps the registered scope.
- Validate executable checks on the pinned commit for every task before registering a branch batch.
  Use the same discovery and required kinds when rechecking a branch during integration.
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
