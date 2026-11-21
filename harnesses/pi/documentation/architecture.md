# Runtime boundaries

The orchestrator is a Pi extension. Workers are fresh processes selected by the role's `backend`: Pi
SDK for Codex task coordination/general work and Astra implementation at medium by default, Claude
Code CLI for specialists and explicitly requested Claude implementers. A separate Fable design
advisor runs concurrently with the orchestrator. Claude receives shared and role-specific system
prompts directly. Its native tools are limited to WebSearch and WebFetch; its only MCP server is the
harness bridge. The bridge implements the same scoped tools used by Pi workers.

## Trusted host and untrusted execution

The Codex orchestrator has normal Pi shell and file tools on the host. It can investigate, set up
projects and make small quick edits directly. Explicit delegation and lengthy work go to background
task coordinators. Substantial implementation is routed to workers by its prompt. Worker isolation
is not a sandbox around the orchestrator; its shell can access everything available to the Pi
process.

The host loads role policy, freezes the project adapter and accepted design, creates candidate
snapshots, dispatches workers and writes private receipts. Provider clients need their normal login
and network access. They are trusted host processes; they are not presented as fully containerized
programs.

Worker-issued shell commands run through macOS `sandbox-exec` in disposable project copies with a
clean environment. The profile permits platform executables, runtime dependencies, the disposable
workspace and scratch directory. Home files, host project writes and network access are denied.
Sandboxed npm and npx run offline. Installed binaries run normally and a cache miss returns
immediately. The host can provision a missing dependency. When grouping verification commands,
preserve each check's exit status before formatting its output. Dependencies and harness source are
readable but not writable. Commands cannot retain generated code: scoped file tools perform retained
edits. File tools reject traversal, secret/dependency paths and symbolic links.

When process-group cleanup is denied, the runner also tries to stop the command process itself. The
result retains captured output, elapsed time, timeout or cancellation, and the cleanup error. An
unconfirmed cleanup always yields a null exit code and fails verification.

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
memory/skills, explicit system prompt, web-only native tools and exclusive MCP configuration.
`--safe-mode` cannot be used because it also disables explicitly configured MCP servers. Managed
organizational policy can still apply; the runtime does not bypass that policy.

## Decisions and context

Workshop conversation remains active as decisions evolve. Codex launches independent Fable advice
with the same question, recent user messages and selected document snapshots, then continues its own
reasoning. Results are persisted and delivered as a custom message at a completed model/tool
boundary, before the next model request. A completion while idle starts a response. Waits and
automatic delivery share an atomic persisted consumption record; completed jobs remain eligible
until consumed. A wait after automatic delivery returns metadata. A newer user request supersedes
automatic delivery of older advice. Cancellation also consumes any completed, undelivered result.
Raw advice remains inspectable. Consumption and Pi session append are separate writes: a crash
between them can leave a claimed result without a session message. Inspect the saved consultation
explicitly in that case; automatic recovery does not replay already-claimed advice. Accepted-epoch
context projection admits these advice messages while rejecting obsolete advice. Session
shutdown/replacement/reload and tree changes cancel pending calls. There are two concurrent slots,
bounded input/output and explicit cancellation. Fable uses a fresh CLI process with
WebSearch/WebFetch, no MCP servers and no ambient global customization. It offers sourced guidance
and cannot accept or write a design.

Document changes use a background task when delegated or lengthy, and ordinary tools for small quick
edits. They require no accepted checkpoint and can retain open questions. Only substantial
implementation uses the following scope snapshot mechanism; saving a document preserves the current
session.

The orchestrator's context uses append-only `context_edit` entries to excerpt bulky successful
file/search tool results and historical write/edit/shell arguments after four newer model steps.
Current-request reads remain intact until a successful write/edit supersedes them; current shell
output also stays. Original records remain untouched. User constraints, assistant prose, advice,
failures and tool-call IDs are preserved. Exact editing requires a current read; the excerpt marker
names the full project trace. This reduces redundant payloads during workshops without deciding
which user choices are final.

Consultation input uses small line excerpts, up to twelve recent user messages and explicit older
constraints, bounded at 48 KB. The original user wording is separate from Codex's question framing.
The 350/700-word response targets and consultation triggers are prompt policy. Live behavioral cases
check that simple choices, quiz presentation and document splits avoid unnecessary calls.

When the user requests implementation, `workflow` receives the settled design, invariants,
acceptance conditions, write scope and specialist flags. Delegation validates the design and checks
active/paused path ownership before recording a versioned scope under the project lock. Missing or
unresolved implementation decisions reject dispatch without replacing the existing scope. The worker
sees that immutable snapshot; changes to its scope invalidate candidate verification.

No separate acceptance command or proposal tool exists. Starting implementation does not switch
sessions, cancel design advice or filter conversation history. Normal Pi compaction and tree
navigation remain available, and consultations retain recent user messages from before the worker
scope was recorded. Historical `accepted.json` checkpoints remain readable for resumable work but no
longer establish a host conversation cutoff.

The implementer's pass hands its candidate to workflow verification and independent review. A
required independent verdict belongs to the workflow. A missing prerequisite for the writer's own
work remains a blocker with its original host actions.

Omitting design from `workflow` resumes the recorded scope and candidate. Supplying design starts a
new version from the current project baseline. Existing task ownership and the workflow lock guard
concurrent dispatch. A failed process launch retains its recorded scope and failed-task evidence so
the host can recover without asking for acceptance again.

## Background task coordination

The orchestrator chooses host work or delegation based on context, complexity and disruption.
Routine setup and related edits may stay local, including in fresh sessions. There is no direct-edit
size/call quota. Host tools provide network, dependency installation and Git operations under user
authorization. Worker capabilities are explicit in every assignment and `harness_capabilities`;
`delegate_task.requires` rejects host-only work before launching an incompatible worker. Scoped
`project_edit` performs exact unique text replacement without regenerating a whole existing file.

`delegate_task` and `workflow` return a durable task ID after spawning a detached supervisor. A
project registry reserves write paths under a short OS lock. At most two tasks run; overlapping
paths are rejected with case/Unicode folding. Accepted implementation excludes another writer. Reads
and conversation remain available. Direct write/edit and document formatting check ownership; the
orchestrator's unrestricted shell obeys the same rule through its prompt. Task controls persist
separately from supervisor status, so foreground updates cannot overwrite worker progress.

A fresh Codex coordinator gets a bounded explicit assignment, shared/role prompts and scoped folder
instructions. It can inspect the candidate and delegate children without a call or turn ceiling. Pi
workers and coordinators let the SDK finish recovery from transient model failures before
classifying a task. A successful retry continues the same session and uses its submitted result. An
exhausted or permanent error reaches the host with its provider message.

Writable leaf calls serialize against the candidate. The coordinator holds the same reservation
while engineering and database reviewers work concurrently. It records both outcomes before
releasing the candidate for fixes. General task workers may edit only the task scope; engineering
and DB reviewers are read-only; performance retains its benchmark/instrumentation limits. Leaf
workers cannot delegate. Child receipts bind role, model and candidate snapshot. Requested reviews
must pass on the final snapshot. For a formatter-only repair the host verifies every changed byte
against the original review and pinned formatter output, records a separate zero-model-turn receipt
and preserves host actions, suggestions and required checks. Untagged findings take the normal
review path. Deciding which reviews a prose task requests remains model policy. Substantive
maintenance requires fresh engineering review; the host may waive that review for routine low-risk
maintenance. Required executable checks and conditional DB review remain enforced.

General task candidates are isolated from the live project. Document changes enforce document-only
extensions, Markdown formatting, write scope and ignored/private path exclusions. Maintenance runs
required project tests/lint and DB checks. Cancellation is propagated through coordinator, leaf and
command controllers; scoped steering invalidates a prior result. A late message that was not
consumed blocks integration. The host serializes integration with the workflow lock, rejects a
pending journal, verifies each changed path still matches its baseline and applies the existing
journal protocol. Document tasks preserve unrelated foreground changes. Code maintenance requires
the entire project baseline to stay unchanged so its final checks and reviews still apply. A stopped
supervisor is reported as needs-attention; candidates and evidence remain available. The host
inspects retained candidates before recovery and preserves concurrent edits. A transient child
execution failure can be retried in the same scope; invalid evidence or scope violations continue to
prevent passing completion. Agents have no total-task wall-clock or model-turn cap.

Supervisors survive reload, session exit and foreground interruption. A filesystem observer delivers
terminal results once to the originating session/branch. It batches ready results, appends them at a
safe boundary, and requests a continuation when needed for acknowledgement. While idle, the batch
starts one response. Queued user input takes priority; in-flight requests are not interrupted.
Persisted custom message IDs deduplicate delivery after reload. New sessions can inspect
project-wide status. Paused jobs retain reservations; cancellation keeps ownership until shutdown is
observed. The registry retains at most 200 indexed tasks and limits control messages to 32 and 48
KB. Artifacts remain until explicitly removed.

`task_control pause` aborts the coordinator and its child process tree; only acknowledged `paused`
state permits reassignment. `revise_tasks` replaces complete prompts and repartitions existing scope
among stopped tasks. It preserves original candidates, transfers their changed bytes to fresh
snapshots, rejects conflicting project/candidate changes, and clears stale approvals. A prepared
metadata journal rolls forward under the registry lock before any subsequent mutation or launch.
Other readers may observe a partially replayed batch, but all participants remain paused.
`resume_task` reuses retained work with fresh orchestration and a distinct notification generation.
Revision baselines supersede archived steering without reusing review authorization. Branch tasks
keep their worktree and fixed scope; changing branch ownership requires replacement tasks.

## Live worker observation and guidance

Each new coordinator and execution worker owns a UUID directory under `harness/workers/`. Immutable
metadata records role, assigned model, task, scope, candidate path, process and parent. Review links
point to the latest author whose candidate is being reviewed. Mutable state and normalized visible
conversation entries mirror real SDK/Claude events; raw provider traces remain intact. Hidden model
reasoning is not copied into the viewer. Streaming state writes are throttled to twice per second.
The viewer reads complete JSONL records, bounds displayed history, sanitizes terminal controls and
isolates damaged records. A dead owner process yields a stopped state rather than perpetual running.

The picker and optional noncapturing overlay poll these files without opening another provider
session or changing the active host session. Active/Past filtering retains relevant ancestors and
reviewed authors. New workers support a persistent guidance mailbox protected by an OS lock. Pi
steering queues the exact text and acknowledges actual user-message consumption. The Claude MCP
bridge returns new guidance before the next proposed tool, or alongside the result of a tool already
in progress. Long tools never hold the mailbox lock. Final result acceptance shares that lock with
sending, so a send either blocks premature completion or explicitly fails as too late. These are
delivery receipts; task application still requires ordinary completion gates.

Direct child guidance is mirrored into the task coordinator's existing revision controls, and the
foreground receives a hidden next-turn context entry without a wakeup. Mailboxes preserve up to 32
undelivered messages and the latest 100 delivered receipts; raw conversations preserve consumed
messages. Guidance cannot alter immutable write/tool scope. Legacy task rows show the saved
coordinator session and route messages through existing task controls. Standalone design advice
keeps its consultation inspection and cancellation path.

Mixed-generation tasks retain a legacy coordinator row even when new children have live metadata.
Missing parent links are reconstructed in the display from the durable task ID. A legacy review can
be grouped beneath the latest completed author in that task's same candidate, with an explicit
Details label. Reconstruction never rewrites worker metadata or creates review authorization.
Guidance to such a child also updates its real coordinator's task controls. A live coordinator's
explicit links take precedence; accepted workflows with live leaves gain no fictitious coordinator.

## Workflow and persistence

Independent remote-branch execution is described in [branches.md](branches.md). A parent Pi session
pins a committed design and remote-main revision, then starts up to four autonomous Codex branch
orchestrators in Git worktrees. Their Astra/Fable children and executable checks run independently.
Tasks publish branches by default; only an explicit merge request authorizes main updates. The
common-Git-directory merge lock serializes publication to main. Changed bases require fresh review
and tests. GitHub CI failures feed back into the task's orchestrator. Individual operations remain
bounded and cancellable; the branch orchestration service loop has no child-call, turn,
implementation repair-round or overall-duration ceiling. External GitHub review feedback follows the
user's separate maximum of five observe/triage/fix/push rounds, with durable accounting and
current-head matching. The parent session remains available for conversation.

Recurring task definitions and cursors live under the local Pi agent directory in
`recurring/<project-path-hash>/schedules.json`. The owning session observes due times, holds a
project-specific lock through dispatch and records the job ID before starting its supervisor.
Projects cannot enable schedules by supplying a file. Occurrences share the ordinary task queue,
write reservations, subprocess controls and result delivery. An audit advances its evidence cursor
after successful completion. Explicit Fable audits dispatch a read-only progress-auditor directly
through the existing Claude CLI worker adapter. The host publishes JSON in `.pi/audit/` by default
or dated Markdown in configured private report folders under `.pi/audit/` and `.pi/audits/`. Workers
receive bounded trace observations and the preceding report summary. Both report trees are excluded
from worker reads and edits. An authorized, evidence-backed stop decision from a completed
occurrence retires its schedule. Revising the work invalidates a pending decision.

Execution evidence is project-local under `.pi/traces/`, ignored through `.pi/.gitignore`.
Conversations live in `sessions/`; checkpoints, attempts, consultations and receipts live in
`harness/`. Worker snapshots and scoped reads exclude this private tree, including case/Unicode
aliases. The launcher sets Pi's session directory directly. When ordinary Pi stores a session
elsewhere, the extension mirrors it after turns and lifecycle events, and compares filesystem
device/inode identities to avoid replacing Pi's own live session file. Codex workers persist
complete Pi session traces; Claude workers capture streamed JSONL events, bounded at 16 MB per
attempt. Oversized output fails explicitly.

Each local accepted-design workflow has one project lock and no repair-round ceiling. Repeating an
identical failure with an unchanged candidate produces an actionable blocker. Commands, output size,
snapshot file count and size remain bounded. Database review is activated by the checkpoint, changed
persistence modules, SQL/schema files, database configuration or a worker's explicit impact finding.
Prose references outside configured DB paths do not trigger review.

The project lock uses a Python helper holding a kernel advisory lock on a stable inode. Its stdin
pipe closes when the supervisor exits, releasing the lock without stale-file takeover races. An
active legacy PID lock is respected during upgrades. Concurrent acquisition and supervisor death are
exercised with real processes.

Retained candidates resume only against the same accepted design version and unchanged original
project baseline. Changed or missing prerequisites stop recovery. Fresh checks run before
integration. An interrupted review round reuses collected verdicts on the same candidate and
requests the missing roles. Raw command logs remain in host artifacts; the orchestrator receives
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

The DB review trigger disregards prose in leading JavaScript and TypeScript line comments. It
continues to inspect executable query text and both revisions of changed files. Explicit database
scopes and declared impact still request review.

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

## Runtime identity

The version module captures a Git revision and SHA-256 digest of source, role, prompt and package
assets when loaded. Orchestrator role/prompt policy is fixed for that generation. A startup or
reload receipt records its unique load ID, session, process ID, time, reason and actual
registered/active tools. Receipts are appended to `harness/runtime/<session>.jsonl` and the raw
session; timing requests reference the load identity. `/harness-version` and `harness_status` expose
the captured values. A changed disk checkout never changes the identity of code already running. The
installer records its source hash for comparison. A live reload is verifiable by the new ID, reason
and matching hash.

Worker progress is persisted separately from task controls/status, including active child and tool.
Codex streaming events and Claude output update activity timestamps; coordinators forward child
progress. Periodic progress messages enter context privately without waking an idle model. Optional
`report_progress` summaries capture meaningful findings or phase changes without mandatory chatter.
A coordinator records its latest `report_milestone` summary in its progress file. The host also
recognizes an accepted workflow's implementation handoff and a published branch awaiting merge. It
batches new milestones by originating session and branch, deduplicates using persisted message IDs,
and groups subsequent updates for up to a minute. An outcome or attention event can flush the batch
earlier. Only a material event wakes the idle host. A silent task gets one attention notice per
unchanged activity point, while completion and genuine blockers wake the orchestrator. It must
inspect evidence, resolve authorized host-only operations or report the actual external blocker;
repeated identical incapable workers are not a recovery strategy. Recovery first reconciles current
project state and user updates; work already completed directly must not be retried or overwritten
from an old failed candidate.

The host registers Pi code mode alongside direct tools. Its nested tool hook permits inspection
only. The script catalog and tool descriptions use the same allowlist. Model helpers are disabled.
Pi workers load a separate read-only script catalog using their scoped file tools. The
[code-mode tool inventory](code-mode.md) describes each role boundary. Use review_receipts for a
delegation’s current attempt and inspect_pr for a one-shot GitHub read. Missing evidence is null.
Timing rows link nested calls to their parent so overlapping durations can be measured once. The
parent tool result retains the identity, status and snapshot of non-passing checks even when a
script selects only verdicts.

Claude worker tools validate arguments before execution. A rejected call identifies the failing
field and schema constraint so the worker can correct it without escalating to the host.
