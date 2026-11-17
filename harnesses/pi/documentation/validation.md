# Validation record

Validated locally on 17 November 2026 with macOS, Node 26.12.1, Pi 1.5.2, Claude Code 2.1.326 and
Bun 1.3.5.

## Automated checks

`./bin/verify.sh` passes repository-wide executable lint, Pi formatting and strict TypeScript
checks, 53 Pi harness tests, 132 existing evaluation tests, 13 skill-validator tests and the skill
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
