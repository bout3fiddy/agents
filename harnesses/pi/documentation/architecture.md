# Runtime boundaries

The orchestrator is a Pi extension. Workers are fresh processes selected by the role's `backend`: Pi
SDK for implementation, Claude Code CLI for the three specialists. Claude receives shared and
role-specific system prompts directly. Its built-in tools are disabled and its only MCP server is
the harness bridge. The bridge implements the same scoped tools used by Pi workers.

## Trusted host and untrusted execution

The host loads role policy, freezes the project adapter and accepted design, creates candidate
snapshots, dispatches workers and writes private receipts. Provider clients need their normal login
and network access. They are trusted host processes; they are not presented as fully containerized
programs.

Model-issued commands run through macOS `sandbox-exec` in disposable project copies with a clean
environment. The profile permits platform executables, runtime dependencies, the disposable
workspace and scratch directory. Home files, host project writes and network access are denied.
Dependencies and harness source are readable but not writable. Commands cannot retain generated
code: scoped file tools perform retained edits. File tools reject traversal, secret/dependency paths
and symbolic links.

Read-only access to the harness is restricted to its runtime assets, excluding private reports.
Homebrew configuration and service-data directories are excluded. A command that leaves inherited
streams open after its parent exits fails after a bounded drain. Deliberately detached daemons are
unsupported: this is not a process container, and an escaped process can outlive its process group.
Ordinary cancellation terminates the command group. Abrupt host termination cannot guarantee cleanup
of every detached descendant; use a VM adapter for workloads requiring that containment.

This protects against ordinary model tool misuse and project commands. It does not defend against a
malicious provider client, OS/kernel exploits, compromised installed dependencies or every possible
side channel. macOS sandbox-exec is a platform dependency; other platforms fail closed until a
tested adapter exists.

Claude invocation uses the `clod` flag, empty cwd, empty settings sources, disabled hooks/automatic
memory/skills, explicit system prompt, no built-ins and exclusive MCP configuration. `--safe-mode`
cannot be used because it also disables explicitly configured MCP servers. Managed organizational
policy can still apply; the runtime does not bypass that policy.

## Decisions and context

The draft contains objective, final design, invariants, acceptance conditions, write scope,
specialist flags and unresolved questions. User acceptance writes a versioned checkpoint atomically
and switches to a new Pi session. Queued input prevents that switch. The old session is retained for
human inspection.

Every model request projects conversation messages through the accepted epoch. Old
user/assistant/tool messages are excluded. Upstream compaction and branch summaries are excluded
because they can contain superseded exploration. The current checkpoint and workflow state are
rebuilt from host records.

Compaction records post-acceptance user requests verbatim, bounded at 48 KB, alongside the accepted
checkpoint and work state. The context hook restores those requests from the current branch's
matching compaction details. If that bound is exceeded, compaction stops and requests an updated
design checkpoint. This favors preserving user constraints over silently truncating them.

Acceptance is explicit. The runtime cannot decide on its own which tentative conversation statements
the user considers final. An unresolved question blocks implementation. A changed accepted design
invalidates an in-flight candidate.

## Workflow and persistence

Each workflow has one project lock and at most three repair rounds. Commands, model turns, output
size, snapshot file count and size are bounded. Database review is activated by the checkpoint,
changed paths/content or either worker's database-impact finding. The detector is conservative;
explicit project paths and independent review complement it.

The project lock uses a Python helper holding a kernel advisory lock on a stable inode. Its stdin
pipe closes when the supervisor exits, releasing the lock without stale-file takeover races. An
active legacy PID lock is respected during upgrades. Concurrent acquisition and supervisor death are
exercised with real processes.

Retained candidates resume only against the same accepted design version and unchanged original
project baseline. Changed or missing prerequisites stop recovery. Fresh checks and independent
reviews run before integration. Raw command logs remain in host artifacts; the orchestrator receives
compact role summaries, findings and check statuses. Worker assignments use bounded receipt excerpts
and label omitted output explicitly.

Worker self-reports are evidence, not completion authority. Host commands execute on fresh
snapshots. Required failure, skip, timeout, cancellation or absent test configuration prevents
completion. Reviews name the exact snapshot reviewed. Performance writes happen before final
verification and review so instrumented code is included in both.

The candidate is applied only if the original project snapshot is unchanged. An integration journal
holds before/after bytes outside worker reach. Recovery checks all paths before applying anything
and stops on unexpected values. No Git reset, clean, commit or stash is used. Dirty and untracked
authored files are part of the original snapshot. Git-ignored files and standard dependency/private
paths are excluded. Large repositories require a narrower project boundary.

Repository checks are trusted acceptance definitions, and their code executes inside the command
sandbox. Review still needs to detect meaningless tests, weakened assertions or benchmarks that
measure the wrong boundary. Passing commands alone does not establish durability, security or useful
coverage.

## Database and performance scope

Durability is evaluated against a stated failure model: process crash, host/disk loss, region loss
or malicious changes are different requirements. Replication does not substitute for backup and
tested restore. Sharding and replicas need a measured or availability-driven justification, with
consistency and recovery semantics reviewed explicitly.

The performance role writes benchmarks, opt-in instrumentation and reports. Default scope excludes
product code. Approved instrumentation paths are a capability grant; engineering review must still
reject disguised optimization or semantic changes. Tests verify disabled instrumentation behavior
where such instrumentation is introduced. Measured bottlenecks go to the implementer.

Baseline and candidate benchmark receipts retain raw output, snapshot and command. If benchmark
definitions or workloads differ, do not calculate a speedup. Missing or failed baselines must be
disclosed. A public-path canary can reject a regression; a performance claim requires matched full
measurements.
