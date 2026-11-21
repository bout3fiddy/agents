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
  while discussion continues. Delegate substantial implementation to Astra; Fable 5.2 medium or high
  supplies independent design advice and explicitly requested performance measurements.
- Keep shell activity folding in the TUI renderer. Preserve observed failures, raw drill-down and
  transcript ordering. Exercise live and resumed sessions with `scripts/check-shell-terminal.py`.
- For a multi-step operation owned by the host, use session-local host_work. Preserve explicit
  pauses, external waits and newer user input. Test actual settlement with tests/host-work.test.ts.
- When an external Actions run gates host work, persist the run watch in its originating session.
  Wake the idle host once with the run identity and follow-up. Exercise completion, lookup failure
  and reload with `tests/github-run-watch.test.ts`. Pin merge follow-ups to their PR head. Test CI
  timing and same-head discovery with `tests/ci-timing.test.ts`. Keep one-time merge authority in
  the task.
- Keep trusted policy and receipts outside worker workspaces. Delegated product edits go through
  scoped workers and snapshot-bound verification. Never silently fall back from worker sandboxing.
- Workshop document edits require no acceptance checkpoint, implementation worker or test adapter.
  Preserve workshop conversation and pending user input. `workflow` takes a settled design when the
  user requests implementation, records its scope and starts work without a separate acceptance
  command. Scope snapshots must not reset sessions or filter host/advisor conversation by date. Keep
  normal Pi compaction and tree navigation; preserve compatibility with stored worker scope.
- Check source and active research before requesting design advice. Route code reviews and audits to
  repo-capable roles. Exercise operational reconciliation and explicit design workshops live.
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
- Keep inherited out-of-scope lint failures blocking. On local implementation, send attributable
  failures directly to the host with the candidate and existing worker handoffs. Mixed failures
  still go to the writer for repair.
- Record actual model/effort and request/model/tool timing under project-local `harness/timing/`.
  Respect the selected orchestrator model; implementation remains independently pinned to
  `openai-codex/gpt-6.2-astra` with medium as the default.
- Orchestrators choose worker thinking up to high. Use medium for settled implementation, low for
  mechanical work, and high for difficult diagnosis. Fable specialists accept medium or high.
  Preserve optional-field compatibility in stored jobs.
- Runtime traces belong under the target project’s gitignored `.pi/traces/`; keep them out of worker
  snapshots. The launcher persists local sessions; ordinary Pi sessions are mirrored.
- Keep prompts in `prompts/`, role definitions in `roles/`, and harness validation evidence in
  ignored `reports/`. The installer backs up changed Pi assets and never reads credential contents.
- Preserve exit status, required skips, cancellation and stale evidence as distinct outcomes.
- Benchmarks measure real public behavior. Instrumentation must preserve disabled behavior.
- Recurring schedules use the host-only recurring_task tool and private per-project definitions.
  Keep .pi/audit and .pi/audits private. Run requested immediate baselines. Skip idle intervals,
  serialize claims and use ordinary delegation controls. Fable audits use the read-only
  progress-auditor. Bind stop decisions to the configured work and the completed occurrence. Test
  Codex and Fable with `npm run test:live:recurring` and its `-- --fable` option.
- The launcher lets the role select active tools at reload. Diagnose missing role tools from the
  registry and tell the user how to resume a session with a legacy startup allowlist.
- Background task processes survive reload and session exit. Keep project-wide file reservations,
  scoped coordinator children, steering/cancellation, and per-task private evidence. Deliver
  completion once at a safe boundary and wake an idle orchestrator for a brief acknowledgement.
  Batch simultaneous results and prioritize queued user input. Test against the real Pi SDK.
- Apply document candidates only after scope, format, control revision and changed-file conflict
  checks. Maintenance code requires executable project checks. Never replace a pending integration
  journal. Keep subprocess cancellation bounded and propagated.
- Choose direct work or delegation from context, complexity and disruption. Routine setup and
  related edits may stay on the host; substantive implementation, explicit delegation and
  distracting lengthy work go to workers. No direct-edit file/byte/call quota exists. Verify changed
  behavior with executable tests and lint.
- Inspect host/worker capabilities before dispatch. Workers cannot install dependencies, retain
  shell-generated lockfiles, configure host policy or publish Git. Handle authorized host operations
  directly, reject incompatible declared requirements, and use structured hostActions for handoff.
  Inspect and recover retained work instead of repeating an incapable worker. Never resume explicit
  user cancellation without a new request.
- Pi worker batches containing retained writes or formatting execute in tool-call order. Use
  project_edit.additionalEdits for multiple exact replacements validated before one file write.
- Give workers changed paths from the original snapshot, including additions and deletions. Keep
  baseline hashes in host evidence. Preserve full folder rules on default reads and when they
  change.
- Workers use project_edit for focused existing-file changes. Preserve exact text, reject ambiguous
  matches and enforce the same scope/private-path/symlink controls as full writes.
- Persist child/tool progress and emit periodic context updates without new model turns. Emit one
  attention notice when activity is absent, inspect the cause, and recover within original
  authority. Silence alone never cancels work. Test progress delivery and reload deduplication with
  the real SDK.
- Preserve the user's explicit priority through side questions and worker handoffs. Required audit
  findings go to the host with the report path. Keep an empty-response follow-up bounded to one.
- Keep internal progress messages hidden from the user. Worker-authored summaries describe
  meaningful findings, phases or blockers; telemetry remains automatic. Guidance requests are
  exceptional and identify a concrete missing decision or capability. `/workers` exposes live status
  and optional metadata without flooding the orchestrator conversation.
- Surface meaningful project milestones through one brief host summary at a safe boundary. Batch
  related outcomes, preserve pending user input, and deduplicate across reload. Routine worker
  activity stays private. Keep only the latest routine progress per task in model context. Preserve
  raw receipts, substantive notices and progress from a later resumption.
- Verify formatting with executable lint. Run recovery checks for actual persistence impact.
- Performance measurement is the only review role and requires explicit user selection. Route defect
  reproduction and repairs to the implementer and verify the final candidate.
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
- Local fan-out pins the current checkout commit and runs implementers directly. Preserve the shared
  workload, isolated candidates, single competition winner and local-only integration. Exercise the
  local host tools and changed-base revalidation with the local-candidate tests.
- `delegate_branches` pins a settled committed design and remote-main baseline for up to four
  independent tasks. The branch orchestrator owns its implementation/review/repair cycle and needs
  no routine human approvals. It has no child-call, turn or total-duration ceiling. All agents
  follow this uncapped policy. Keep explicit cancellation, bounded command execution, scopes and
  concurrency controls; turn counts are telemetry only.
- Store delegated implementation attempts under their owning task so the worker picker and traces
  can identify the task. Keep the project checkpoint shared with foreground workflows.
- Read-only research completes when it reports findings. Preserve its original verdict and keep
  blocked reports actionable. Writable jobs still require a passing verdict.
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

Claude specialists prefer Fable 5.2. On a confirmed usage limit the harness selects Opus with the
same role and effort until the reported reset. Attribute results to the recorded model.

Astra implements by default. When the user explicitly requests Opus or Fable to implement a design,
set `implementerModel` to `opus` or `fable` on the workflow, maintenance task, or individual branch
task. Route implementation and repair through its tracked implementer. Claude implementers use
medium or high effort. When Fable reaches its usage limit, Opus continues the same task at the
selected effort.

Give delegated tasks and individual branch assignments a short, distinctive `title` for /workers.

Keep Pi code mode optional and inspection-only. Audit tool changes against
documentation/code-mode.md. Enforce nested tool permissions in tool_call, preserve parent call IDs
in timing, and keep actions available directly. Worker conversations summarize tool payloads for
display and retain the raw transcript behind the r key.

Automatic updates use the completed local install receipt and Pi’s TUI command dispatch. Exercise
install, deferred reload and build verification in a disposable terminal with
`uv run --with pexpect scripts/check-auto-reload.py` after changing this path.

- Use task_control action=evidence for an observed fact needed by a live fixed-design implementer.
  Bind delivery to the accepting worker and original task. Never change its design or review scope.

- Optional implementer assessments carry snapshot-specific TigerStyle evidence and the test
  scorecard. Preserve unscored historical receipts. Exercise the implementer submission tool and
  receipt readers when changing the rubric. Keep Playwright journeys applicable to browser-visible
  behavior.
- A retry blocker is a visible transition in host_work. Test deduplication and continuation through
  the Pi session boundary. Keep routine polling private.
- Keep main sync independent of the model. Test remote refresh and checkout preservation with real
  Git repositories and linked worktrees. Preserve fast-forward-only behavior and repository opt-out.
