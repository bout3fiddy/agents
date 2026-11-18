# Validation record

Validated locally on 18 November 2026 with macOS, Node 26.12.1, Pi 1.5.2, Claude Code 2.1.326 and
Bun 1.3.5.

## Direct implementation dispatch and GPT 6.2 Astra (0.6.0)

Implementation is pinned to `openai-codex/gpt-6.2-astra` at high effort. The legacy acceptance
command, proposal tool and acceptance-driven host context filtering are removed. `workflow` records
the supplied settled scope and starts its background task directly. Existing saved scopes remain
resumable. Scope conflicts, unresolved decisions and an occupied workflow lock reject dispatch
without replacing the existing scope.

Focused workflow, delegation, model-policy, installation and SDK lifecycle checks passed. They cover
normal compaction, resume and tree navigation with an older checkpoint, preservation of discussion
and advisor history, direct scope recording and safe resume. Formatting, lint and type checks pass.
The initial model-only change also passed the existing 206-test suite; the subsequent acceptance
removal used only relevant tests. Evidence: `reports/astra-6.2-direct-workflow-tests.log` and the
final SDK lifecycle rerun at `reports/direct-workflow-context-tests.log`.

The real Codex host dispatched the exact supplied design without any acceptance command, Astra 6.2
implemented it and Fable reviewed it successfully in one round. Seeded input properties and final
host checks passed. Evidence: `reports/2026-11-18T10-03-22.714Z/`. The earlier model-only live check
also passed at `reports/2026-11-18T09-54-35.290Z/`. Both use disposable counter projects.

## Trace audit: mixed worker generations (0.5.1)

The next trace audit found a 0.4.1 coordinator launching newer execution workers during the 0.5.0
rollout. The 0.5.0 picker suppressed its legacy coordinator row whenever any live child existed,
leaving workers ungrouped and omitting coordinator notification for direct child guidance. Read-only
replay of task `be43487b-7939-427e-94ee-aa72d7478a69` reproduced the defect. The catalog now
preserves that coordinator and reconstructs missing relationships from task/candidate history.
Explicit links remain authoritative, inferred placement is labelled and original metadata is
unchanged.

Regression validation also exposed Escape being ignored during an asynchronous guidance send, and
the accepted-context allowlist dropping the host copy of current worker guidance. Both are fixed;
pending delivery continues when leaving the composer, and superseded guidance remains excluded. All
206 tests pass, including same-candidate review grouping, coordinator notification, exact text,
Escape during delivery and accepted-context preservation. The live Codex/Fable guidance case passed
in 150.1 seconds, with a 3.4-second concurrent discussion response:
`reports/workers-1794961598399/`. Terminal navigation, resizing and reload checks passed at
`reports/terminal-1794961722/`. The accepted implementation workflow passed in one round with real
Astra and Fable at `reports/2026-11-18T00-30-23.849Z/`.

The monitored assignment continued through productive drafting, review and repairs. Its new host
turns spent 607.3 seconds in model requests and 2.7 seconds in tools; one substantive consultation
and one background task were dispatched. The audit changed no assignment files or live task controls
and forced no reload. Detailed evidence and consumed offsets remain under `reports/trace-audit/`.

## Live worker conversations and hierarchy (0.5.0)

All 203 Pi tests pass with no skips, including formatting, executable lint and strict TypeScript
checks. Repository-wide code lint passes. Actual SDK tests open the picker and noncapturing panel
while the host model is streaming, preserve its session and request count, and consume worker
guidance without aborting a model request. Tests race guidance against completion, deliver during
long tools, preserve text/Unicode, isolate damaged traces, retain reviewed authors in the Active
tree and mirror child guidance into coordinator controls. Private progress includes meaningful
summaries without waking the model or rendering raw progress blocks.

The real Codex/Fable guidance run passed in 141.1 seconds. Dispatch returned in 11.8 seconds and the
host answered another discussion prompt in 4.7 seconds while work continued. Guidance changed queue
capacity from 100 to 120 in the live document worker, then reached the independent reviewer. Both
delivery receipts were recorded and the correct document integrated. Evidence:
`reports/workers-1794960236442/`. The accepted implementation workflow also passed in one round with
real Astra and Fable: `reports/2026-11-18T00-12-19.283Z/`.

The installed CLI passed a disposable PTY test with explicitly synthetic workers at 140, 80 and 40
columns. It exercised hierarchy, Active/Past, conversation, metadata, task prompt, guidance, host
input with the panel open, narrow-terminal hiding and reload identity. Screen captures and raw ANSI
output are retained under `reports/terminal-1794961119/`. Direct child guidance requires newly
started workers; legacy jobs expose coordinator control. The panel uses an overlay and can cover
underlying text. Standalone design consultations retain their existing inspection tools.

## Trace audit: document exclusions and completion diagnostics (0.4.1)

The hourly audit found eleven excluded design files incorrectly reported as requiring formatting.
The host trace was from 0.3.0; the bug independently reproduced in 0.4.0. Document tools and the
integration gate now honor root `.prettierignore`, report skipped formatting, preserve excluded
bytes and retain line-width checks. Ignore policy is bounded and symlink-checked; executable
formatter configuration is not loaded. Read-only replay against the retained eleven-file candidate
passes with no writes. The separate missing-Git prerequisite remains a host action.

The first live regression exposed a generic completion error after a follow-up used a different
write scope. Completion diagnostics now name the outstanding role and exact scope. Regression
coverage rejects mismatched clearance, accepts matching clearance and reuses unchanged passing
reviews. Prompts keep subsequent specialist reviews with the coordinator, so editing leaves can
finish their own acceptance criteria. The first run is preserved at
`reports/delegation-1794957109215/`.

The live rerun passed in 83.2 seconds with one task-worker and one Fable reviewer. Dispatch returned
in 11.4 seconds, and the next discussion response took 3.4 seconds while work continued. Excluded
blank lines survived integration, completion arrived once, and reload did not repeat it. Evidence:
`reports/delegation-1794957349901/`. Run this case with
`npm run test:live:delegation -- --excluded-documents`.

All 194 Pi tests pass with no skips, plus formatting, executable lint, strict TypeScript checks and
repository-wide code lint. Evidence lives under `reports/trace-audit/`.

## Worker recovery and contextual routing (0.4.0)

All agents now have no model-turn, child-call or total-task duration ceiling. Regression tests
accept a 46-turn Claude review, complete twelve child assignments, recover a transient child
failure, and finish a productive five-round local repair. The separate five-round external GitHub
review policy remains. Identical failures without candidate changes return to the host for
diagnosis.

The host-routing live fixture completed a fresh local Git/npm/Prettier setup in 28.5 seconds with
six host calls and no delegation or Fable review. A later explicit background edit changed a 40 KB
document using one project_edit and zero project_write calls while discussion continued. Evidence:
`reports/host-routing-1794949232231/`. The accepted implementation workflow also passed with actual
Astra and Fable in one round: `reports/2026-11-17T21-00-31.801Z/`.

The recovery live fixture paused two real workers after retained edits, inspected drafts, swapped
ownership, revised assignments and resumed both to completion in 85.6 seconds. The host made no
direct file edits. Both paused outcomes and both resumed completions reached the parent once.
Evidence: `reports/task-recovery-1794950473114/`. Its first attempt exposed temporary pause wording
copied into task context; explicit runtime resume state and lifecycle prompt guidance fixed that
behavior. The successful run consumed a revised control baseline after prior steering.

Deterministic and actual SDK tests cover retained edits, paused ownership, batch transfers,
conflicting live changes, unauthorized scope expansion, partial metadata recovery, branch worktree
resumption, progress without model calls, silence attention, and reload deduplication. Host-only
requirements fail preflight or return structured hostActions. Routine maintenance may omit a
specialist review while retaining required executable checks. The Pi verification suite passes 189
tests with no skips, including executable lint, formatting and strict TypeScript checks.
Repository-wide verification also passes 132 evaluation tests, 13 skill-validator tests and the
routing audit. Accepted implementation workflows forward worker/tool activity through the same
parent progress channel as general and branch coordinators.

The full live SQLite workflow passed after two rounds with real Astra implementation and Fable
performance, engineering and database roles: `reports/2026-11-17T21-25-11.345Z/`. Independent
reviews found Unicode ID aliasing, concurrent WAL startup and a balance scan under the writer lock.
Astra repaired the fixture, all specialists passed the final snapshot, and post-integration checks
passed. The repair used 46 model turns and the benchmark refresh 43; both results were retained
normally.

## Independent branch orchestration (0.3.0)

Real Git regression tests cover concurrent worktrees, separate pushed branches, serialized
integration, changed-main revalidation, remote update races, scoped conflict repair, cancellation,
server-side rejection, and committed bytes changed by Git attributes or filters. GitHub adapter
tests cover exact PR heads, paginated checks, CI failures with log excerpts, pending CI,
cancellation, outstanding review objections and PR creation races.

Coordinator tests run beyond the former child-call ceiling. Integration tests run 28 repair rounds
without a fixed limit, exercise real failing behavioral checks and stale/missing review repair, and
confirm foreground discussion continues while both tasks run. In 0.3.0 the ordinary task coordinator
retained its limits; 0.4.0 removes those limits across all roles.

The live GitHub fixture ran two real Astra implementations and Fable engineering reviews in
parallel, published separate branches/PRs with passing CI, and preserved main until a later
natural-language merge request. Both then merged sequentially; the second refreshed review and tests
against main containing the first. The foreground answered another question in 4.3 seconds while
workers ran. The original checkout remained unchanged. Evidence: `reports/branches-1794946217354/`
and the two merged PRs in `bout3fiddy/pi-harness-worktree-validation-20261117-v2`.

The first live attempt exposed GitHub's brief old-head response after a push. The adapter now waits
only for a known previous head; unexpected heads still fail. The second completed both merges but
its final test counter missed idle notifications because it observed only `entry_appended`. All four
persisted notifications and model acknowledgements were present. The counter now reads session
entries; `postcheck.json` records re-executed Git, checkout, notification and real SDK reload checks
against those retained artifacts, with no replay or new model turn.

External review policy is tested with deterministic GitHub responses and real Git repair/push
cycles: no triggered agent, delayed discovery, false positives, changed comments, stale heads, five
rounds, interruption during the fifth repair and persisted resumption. The live fixture had ordinary
GitHub CI and internal Fable reviews; no external review bot was configured. Six real-Git final-gate
cases cover controls, human objections, failing CI reruns, cancellation and merge-authority changes
arriving during an external review wait, plus the unchanged success path.

Handoff text tests preserve spaces, newlines, Unicode, quoted text and identifiers through every
two-chunk SDK JSON boundary, character-at-a-time streaming, consultations and persisted task
steering. A reported joined-word handoff was already joined in the saved assistant tool arguments;
all inspected downstream copies matched exactly. The SDK source preserves argument deltas. Shared
and orchestrator prompts now explicitly require ordinary prose spacing. Raw provider wire data was
unavailable, so the trace does not conclusively separate model generation from upstream parsing.

## Automatic document routing and completion delivery (0.2.0)

The natural-language live request specified three design documents and asked to continue the quiz;
it contained no tool name or request for a subagent. The orchestrator automatically dispatched one
document task, returned in 14.0 seconds, then answered the next quiz question in 6.1 seconds while
work continued. No foreground write/edit ran. One general worker updated all three documents,
completion woke the orchestrator for acknowledgement, and reload produced fresh load receipts
without repeating the notification. Report: `reports/delegation-1794937949079/`.

The live workshop also passed: substantive Fable advice, a quick direct single-document correction,
a quiz, and automatic background delegation of a three-file document split. No new Fable
consultation was added for document work. Report: `reports/workshop-1794937949079/`.

Regression tests exercise oversized, multi-file, repeated, late and shell-based document edits;
small corrections remain available. Completion tests cover idle, busy and queued-user cases, batch
simultaneous results into one acknowledgement, and reject replay after reload. Runtime tests load an
extension from disk, modify it, reload it and verify the changed code executes. Receipts record
actual tools and a new load ID; request timing binds to that ID. A later source edit cannot relabel
a captured build. SDK fixtures now install lifecycle bindings so reload emits its startup event.

## Initial background delegation (0.1.0)

The delegated-document scenario uses the same user wording that exposed the original gap: record
settled decisions through a subagent and continue quizzing. Codex returned in 10.4 seconds while the
task was active; after `/reload`, the next quiz response took 3.9 seconds. Its background
coordinator called a scoped Codex task worker and the explicitly requested Fable reviewer. The final
document passed, an unrelated foreground edit survived integration, and completion arrived once
without an extra model turn. There were zero foreground write/edit calls. Report:
`reports/delegation-1794933182536/`.

The installed `pi-harness` launcher returned in 13.1 seconds, exited, and its detached document task
finished after 42.2 seconds. It preserved the open question and called only the general task worker;
no routine Fable review was added. Evidence: `reports/delegation-installed-result.json`.

The first live attempt exposed a missing worker `document_check` capability. The tool now uses the
same pinned formatter as the orchestrator, with all paths validated before formatting and read-only
coordinator access. A separate live coordinator run consumed a task update during child execution
and delegated the revision to a second worker. The background accepted-design workflow also passed
with Astra high and Fable review in one round: `reports/2026-11-17T16-33-03.394Z/`.

Regression coverage includes real Pi dispatch/continued conversation, ownership guards, idle
completion without provider calls, reload deduplication, disjoint concurrent document application,
conflict/scope/format rejection, late steering, cancellation, stale reviews, required maintenance
review/DB/benchmark checks, skipped-test receipts and unchanged code baselines. Process tests prove
cancellation reaches independently grouped sandbox commands through both Pi workers and MCP bridge
processes, including a bounded fallback and cancellation during setup. The full suite also caught
and fixed stale-context polling after SDK disposal.

## Automated checks

`./bin/verify.sh` passes repository-wide executable lint, Pi formatting and strict TypeScript
checks, 174 Pi harness tests, 132 existing evaluation tests, 13 skill-validator tests and the skill
routing metadata audit. No tests were skipped.

The harness tests exercise:

- Actual Pi SDK context projection across compaction, resume and old-branch navigation; queued input
  prevents design acceptance, and an accepted replacement starts with the final checkpoint.
- The real Claude MCP bridge, including denied product writes for the performance role, allowed
  benchmark writes, private-path/traversal rejection and explicit CLI isolation flags.
- Real macOS sandbox denial of outside reads, writes, symlink escape and network; bounded output,
  command timeout and cancellation.
- Partial integration recovery, concurrent edits, stale review evidence, required skipped checks,
  conditional database review and the repair loop.
- Retained candidate resumption, changed baseline rejection, same-design reacceptance, missing
  acceptance gates before dispatch and compact orchestrator context.
- Unicode/case aliases, private report denial, Git-backed and nested-root inventories, bounded
  detached-child completion, truncated test output and clean Claude launch failures.
- A filesystem oracle covering 149,790 Unicode code points and all 11 aliases observed on this
  volume; 16 competing lock acquisitions; supervisor-crash release of a kernel advisory lock.
- Formatter idempotence over 100 seeded cases, comment-like strings, Python token handling,
  malformed JSON and a sparse 3 GB image that lint must skip.

All 16 changed pre-existing Python files retain identical parsed ASTs. Syntax checks pass for the
five changed pre-existing shell scripts. Existing evaluation code retains its formatting style.
`npm audit --omit=dev` reported zero known production dependency advisories on this date.

## Installed runtime

The installed `~/.pi/agent/bin/pi-harness` and ordinary `pi` each completed a real Codex request
using `harness_status`. The dedicated launcher also executed `/accept-design HASH` through Pi's real
session replacement path. This exposed and fixed an obsolete-context notification after the switch;
the confirmation now uses Pi's `withSession` callback.

Doctor reports the macOS sandbox ready, Claude logged in and all configured roles available. These
configuration checks supplement the real provider calls; listing models alone does not prove that
credentials are accepted by the provider.

The 47 captured installed Codex/shared files retain their original SHA-256 values. Claude's old
global `CLAUDE.md`, skills, agents, commands and workflows are absent. Its credentials and ordinary
settings remain in place. No backup of those removed Claude instruction assets is retained.

## Workshop, shell access and project-local traces

The trace-driven workshop fixes add real Pi runtime regressions for completed-before-wait advice,
automatic delivery before the next model step, late cancellation, older advice after new user input
(including explicit waits), and an unreadable result alongside a valid result. Fault injection
covers storage failure and a user-input change, abort or navigation during a delivery claim. Context
tests preserve user decisions, errors, current unchanged reads, tool-call pairing and raw traces
across resume; malformed historical calls and Unicode excerpt boundaries are exercised.

The final live workshop run (`reports/workshop-1794929184681/`) used real Codex and Fable calls:

| Scenario                 | Duration | Main model steps | New consultations |
| ------------------------ | -------: | ---------------: | ----------------: |
| Record a settled choice  |   18.7 s |                5 |                 0 |
| Present the quiz         |   10.7 s |                1 |                 0 |
| Split existing documents |   27.0 s |                9 |                 0 |

The substantive question did consult Fable, Codex responded while advice was pending, and advice
arrived automatically. The provider accepted further requests after persisted context edits
excerpted an earlier large read. The document checker ran, files retained the selected
capacity/rejection policy and open persistence question, and no implementation worker ran.

A private replay of the observed project's pre-compaction history reduced visible text/tool-argument
content from 800,518 to 362,083 characters (54.8%), preserving all five user messages and
tool-result identities/statuses. This is a content-volume measurement, not a matched latency
benchmark. Current reads and current shell output remain protected. Evidence:
`reports/workshop-replay/final-result.json`.

The web capability run (`reports/web-1794928122002/`) passed actual WebSearch and WebFetch calls for
Fable advice and engineering review, including citations and the scoped result handoff. The
independent Fable source review informed the added interruption/storage/history regressions; its
speculation about multiple boundary handlers was checked against Pi's chained boundary API and
runtime behavior.

Request/model/first-text/tool timing now persists separately under project-local `harness/timing/`.
The orchestrator's selected model/effort is recorded and preserved. These intervals include provider
and client overhead; no server queueing or reasoning-time decomposition is claimed.

After local installation, the actual `pi-harness` launcher read and edited a settled design, ran
`document_check`, preserved the open question, and wrote a local session and timing trace. It
invoked no consultation or implementation workflow. Evidence:
`reports/workshop-fixes-installed.json`.

The 17 November workshop revision adds Fable design advice alongside the Codex orchestrator, normal
host shell/file tools, and direct design document edits. Implementation is pinned to
`openai-codex/gpt-6-astra` with high effort; all Fable roles use medium or high effort.

New regression checks cover parallel advice, session ownership, cancellation, interrupted waits,
exactly-once wait consumption, teardown/preparation races, oversized context recovery, persisted
results, private trace exclusions, Git ignore behavior and live-session filesystem aliases. Claude
trace tests exercise an 18 MB Unicode stream against the 16 MB byte budget; partial evidence is
retained on failure. Non-Git lint/format traversal also excludes generated trace contents. The
independent Fable source review identified duplicate wait delivery, cancellation/lifecycle races and
live-file alias hazards; the corresponding fixes have regression coverage.

Real Codex/Fable workshop runs produced Codex guidance before Fable finished, automatically returned
Fable's independent answer, then saved the user's decision directly while leaving a future question
open. No implementation worker ran and the existing checkpoint stayed unchanged. Reports:
`reports/workshop-1794910842913/` and `reports/workshop-1794911492278/`.

The installed launcher also completed a real Codex shell/document request from a fresh directory
with no implementation checkpoint or test adapter. The local session contains 14 unique entries,
with no mirror-induced duplicates. Report: `reports/installed-workshop-result.json`. Runtime
sessions and receipts now live in the project's ignored `.pi/traces/` tree. Existing home-directory
histories remain historical artifacts until explicitly removed.

## Web research

Real Fable design-advisor and engineering-reviewer runs successfully used both WebSearch and
WebFetch against official Node.js documentation, and returned source URLs. The reviewer also used
scoped project_read, run_command and submit_result tools. Successful calls were verified from the
JSONL tool-use/tool-result pairs; failed or unfinished calls do not count as evidence. Project
contents were unchanged. Report: `reports/web-1794913761755/`.

Native Claude tools are explicitly limited to WebSearch/WebFetch. Research guidance lives in
`prompts/web-research.md` and is loaded for all Claude roles. Their file and command operations
continue to use the scoped MCP bridge.

## Live workflow

The Astra high revision completed the full live workload in two rounds. Fable engineering and DB
reviewers reproduced concurrent WAL startup, malformed Unicode ID and benchmark durability issues;
Astra repaired them, and the second engineering and database verdicts passed. The final host checks
passed after integration. Recorded workers use `openai-codex/gpt-6-astra` and
`claude-cli/claude-fable-5-2`. Report: `reports/2026-11-17T10-22-20.556Z/`.

Earlier validation before the Astra model change follows for historical comparison.

The disposable SQLite workload uses seeded replay/conflict properties, invalid inputs, crash
recovery after SIGKILL, rollback, real file-backed benchmarks and independent specialist reviews.
Worker model names and command receipts are retained in private state. Reports are intentionally
Git-ignored.

The reviews detected distinct malformed Unicode IDs collapsing to the same SQLite value, an
unbounded aggregate inside the writer transaction and busy handling during concurrent database
initialization. Codex received those findings and produced repairs and regression checks. The
database review also exercised old and new writers together and required a repair to preserve
balance invariants during mixed-version operation.

The basic live workflow completed in one round with real Codex implementation and Claude Fable 5.2
review. It accepted the design through the CLI command, integrated the verified code, and correctly
left database/performance roles inactive. The final installed version repeated that pass. Local
reports: `reports/2026-11-16T23-13-57.293Z/` and `reports/2026-11-16T23-45-32.424Z/`.

The full SQLite workflow completed after resumption and two further review rounds. Its final
engineering and database verdicts passed, and host lint, seeded contract tests, SIGKILL recovery and
file-backed benchmarks all passed again after integration. All four final receipts match the
integrated snapshot. The recorded worker models are `openai-codex/gpt-6.1-sol` and
`claude-cli/claude-fable-5-2`; all five roles were exercised including the real Pi orchestrator.
Local report: `reports/2026-11-16T23-16-00Z-resumed/`.

An early run reached its original 30-minute outer limit during review and retained its candidate
without integrating it. The live driver now allows 90 minutes while preserving each worker's smaller
turn and time limits, and saves failure reports when interrupted.

Independent Claude reviews of the harness reproduced private-path aliases, unbounded inherited
command streams, truncated skip summaries and Git inventory inconsistencies. Each reproduced defect
has a regression check. Follow-up review exposed capital sharp-s folding and setup-time
cancellation; those were fixed and included in the filesystem oracle and cancellation tests. Model
review is supplementary evidence; the regression tests establish the corrected behavior locally.

## Practical limits

The command sandbox currently supports macOS only. Network-backed database services and external
virtual environments require a separate tested adapter. Provider clients themselves remain trusted
host programs with login/network access; the command sandbox isolates delegated worker commands. The
orchestrator intentionally has ordinary host shell and file access.

SQLite crash tests establish the stated single-machine process-crash contract. They do not establish
disk-loss recovery, replication, failover or regional disaster recovery. Successful model reviews
are evidence for the measured snapshot and do not guarantee future changes.

Failed candidates are retained for inspection and resumption. A changed baseline requires explicit
design reacceptance before starting from the current project.
