# Validation record

Validated locally on 17 November 2026 with macOS, Node 26.12.1, Pi 1.5.2, Claude Code 2.1.326 and
Bun 1.3.5.

## Automated checks

`./bin/verify.sh` passes repository-wide executable lint, Pi formatting and strict TypeScript
checks, 28 Pi harness tests, 132 existing evaluation tests, 13 skill-validator tests and the skill
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

Doctor reports the macOS sandbox ready, Claude logged in and all five roles configured. These
configuration checks supplement the real provider calls; listing models alone does not prove that
credentials are accepted by the provider.

The 47 captured installed Codex/shared files retain their original SHA-256 values. Claude's old
global `CLAUDE.md`, skills, agents, commands and workflows are absent. Its credentials and ordinary
settings remain in place. No backup of those removed Claude instruction assets is retained.

## Live workflow

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
host programs with login/network access; the command sandbox isolates model-issued commands.

SQLite crash tests establish the stated single-machine process-crash contract. They do not establish
disk-loss recovery, replication, failover or regional disaster recovery. Successful model reviews
are evidence for the measured snapshot and do not guarantee future changes.

Failed candidates are retained for inspection and resumption. A changed baseline requires explicit
design reacceptance before starting from the current project.
