# Runtime boundaries

The orchestrator is a Pi extension. Workers are fresh processes selected by the role's `backend`: Pi
SDK for Codex task coordination/general work and Astra implementation at medium by default, Claude
Code CLI for specialists and explicitly requested Claude implementers. Model selection does not
change the assignment: research has no writes, and document jobs retain only authorized documents.
Fable falls back to Opus only on confirmed quota. A shared versioned receipt can skip the Fable
probe before reset for less than 15 minutes after confirmation. Live routing status distinguishes
cached from newly confirmed quota; final evidence records the model used. A separate Claude design
advisor runs concurrently with the orchestrator. Claude receives shared and role-specific system
prompts directly. Its native tools are limited to WebSearch and WebFetch; its only MCP server is the
harness bridge. The bridge implements the same scoped tools used by Pi workers.

## Trusted host and untrusted execution

The Codex orchestrator investigates, sets up projects and accepts verified candidates. Tracked
workers implement and repair project changes, including test fixes and corrections after review. The
host can integrate verified work and publish with authorization. Worker isolation is not a sandbox
around the orchestrator: its shell can access everything available to Pi and must not be used to
bypass file routing.

The host loads role policy, freezes the project adapter and accepted design, creates candidate
snapshots, dispatches workers and writes private receipts. Provider clients need their normal login
and network access. They are trusted host processes; they are not presented as fully containerized
programs.

How worker-issued commands run is the user's decision per project, recorded by the host outside
every project; [worker-execution.md](worker-execution.md) is the authority for it. A project the
user enrolled as `trusted-local` runs them as normal local commands in disposable copies. That is a
statement of trust and no containment: such a command has the user's file, network and process
authority. Every other project, and every task the host marks `isolation: 'required'`, runs them in
the sandbox described next. Nothing a worker, project file or tool argument supplies moves a command
out of it, and a sandbox that cannot start fails the command instead of falling back.

Sandboxed worker commands run through macOS `sandbox-exec` in disposable project copies with a clean
environment. The profile permits platform executables, runtime dependencies, the disposable
workspace and scratch directory. Home files, host project writes and network access are denied.
Sandboxed npm and npx run offline. Installed binaries run normally and a cache miss returns
immediately. The host can provision a missing dependency. When grouping verification commands,
preserve each check's exit status before formatting its output. Dependencies and harness source are
readable but not writable. Commands cannot retain generated code: scoped file tools perform retained
edits. File tools reject traversal, secret/dependency paths and symbolic links.

Each command copy also receives a Git index of its files and, for a checkout, its pinned HEAD.
Objects resolve through alternates to the project repository, which the profile adds as readable.
Host `.venv` links are readable together with the interpreter prefix they resolve to.

A project can mark a check `runner: host`. Such checks run in a disposable copy of the verified
snapshot outside sandbox-exec, with the user's permissions and a minimal environment. They run only
after every sandbox check and harness lint pass, so they never execute for a candidate that already
failed. This is an explicit project decision, never a fallback for a failed sandbox run. Required
isolation refuses such a check and reports it unavailable.

Disposable directories are named `$TMPDIR/pi-<pid><kind>-*` and are removed after the creating
process exits. Retained candidates are `$TMPDIR/pi-task-*` with an owner record naming the project,
state directory and task. Names stay one level below `TMPDIR` because macOS rejects Unix socket
paths over 104 bytes, and project tests bind sockets in their temporary directory. A host cleanup
pass removes copies, worktrees and baselines that no live or resumable task needs, saves an expired
candidate's changes as a patch and marks the task so a resume reports the expiry.

When process-group cleanup is denied, the runner also tries to stop the command process itself. The
result retains captured output, elapsed time, timeout or cancellation, and the cleanup error. An
unconfirmed cleanup always yields a null exit code and fails verification.

Read-only access to the harness is restricted to its runtime assets, excluding private reports.
Homebrew configuration and service-data directories are excluded. A command that leaves inherited
streams open after its parent exits fails after a bounded drain. Deliberately detached daemons are
unsupported: this is not a process container, and an escaped process can outlive its process group.
Ordinary cancellation terminates the command group. Abrupt host termination cannot guarantee cleanup
of every detached descendant; use a VM adapter for workloads requiring that containment.

The sandbox protects against ordinary model tool misuse and project commands. It does not apply to a
trusted-local project, and it does not defend against a malicious provider client, OS/kernel
exploits, compromised installed dependencies or every possible side channel. macOS sandbox-exec is a
platform dependency; other platforms fail closed until a tested adapter exists.

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

Product document changes use a background document task. The host can record a small workshop
decision in `design.md` or `design/design.md`. The 4 KiB workshop limit applies to replacement text
(old plus new for targeted edits); a whole-file write or format also requires a small existing file.
Neither path requires an implementation checkpoint; saving a document preserves the session and can
leave open questions.

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

The implementer submits the candidate for executable verification. It returns a blocked result with
host actions when a prerequisite prevents its own work.

Omitting design from `workflow` resumes the recorded scope and candidate. Supplying design starts a
new version from the current project baseline. Existing task ownership and the workflow lock guard
concurrent dispatch. A failed process launch retains its recorded scope and failed-task evidence so
the host can recover without asking for acceptance again.

## Background task coordination

Route work by ownership, not complexity. Host tools provide network, dependency installation and Git
operations under user authorization. Worker capabilities are explicit in every assignment and
`harness_capabilities`; `delegate_task.requires` rejects host-only work before launching an
incompatible worker. Scoped `project_edit` performs exact unique text replacement without
regenerating a whole existing file.

`delegate_task` and `workflow` return a durable task ID after spawning a detached supervisor. A
project registry reserves write paths under a short OS lock. At most two tasks run; overlapping
paths are rejected with case/Unicode folding. Accepted implementation excludes another writer. Reads
and conversation remain available. At `tool_call`, ordinary host writes, edits and in-place document
formatting check reservations before allowing setup files, small workshop decisions or private
scratch under `.pi/traces/scratch/`. The root README and package manifest are setup files only if
the request began in a fresh root and it still contains only bootstrap artifacts. This lets the host
finish a manifest created by install tooling without granting write access in a manifest-only
product repository. Other destinations get a worker handoff even when no task is active. Integration
operates on verified snapshots, not through ordinary model edits. Task controls persist separately
from supervisor status, so foreground updates cannot overwrite worker progress.

A fresh Codex coordinator gets a bounded explicit assignment, shared/role prompts and scoped folder
instructions. It can inspect the candidate and delegate children without a call or turn ceiling. Pi
workers and coordinators let the SDK finish recovery from transient model failures before
classifying a task. A successful retry continues the same session and uses its submitted result. An
exhausted or permanent error reaches the host with its provider message.

Writable leaf calls serialize against the candidate. Child receipts identify the role, model and
snapshot. A coordinator may send independent read-only questions as one research swarm: a single
`delegate_worker` call whose `researchers` list names each researcher. The coordinator chooses the
group and no fixed size applies. The harness starts every researcher in one pass, keeps no queue and
retries nothing. The swarm is one serialized step, so researchers overlap only with each other while
writers, checks and submission wait for all of them. A researcher that fails or exceeds actual
process or provider capacity is reported by id as unfinished and blocks a passing result until that
id completes. The researcher id is part of receipt identity: siblings share a role and an empty
scope, yet each has exactly one receipt per dispatch, sees only its own previous findings and cannot
clear another's. An edit during a swarm, mismatched evidence or a lost receipt invalidates the
candidate. Cancellation stops every researcher before the call returns and records no receipt.
`src/coordinator-swarm.ts` holds this contract without package dependencies. Run its test with
`node --experimental-strip-types --test tests/coordinator-swarm.test.ts`.

Independent branch coordinators may work concurrently. The coordinator routes a failing behavioral
check to the implementer. The repaired branch closes on passing executable evidence. Database impact
selects recovery checks. Explicitly selected performance workers may write benchmarks,
instrumentation and reports.

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

## Assignments

An assignment is one outcome the user authorized, the target it must reach and who advances it next.
`host_work` records it; the orchestrator chooses the worker, coordinator or branch orchestrator.
Records live in `harness/assignments/<session>.json` under the session's originating project, one
bounded ledger per session: at most 12 open assignments, 48 retained records, eight wake sources and
the last eight attempts per record. A full ledger rejects a new assignment instead of dropping one.
The ledger is independent of the conversation. Navigating the session tree, a new request or a
status question changes no record, and one assignment's update, failure or cancellation leaves the
others unchanged. An interrupt stops the current turn and changes no record either: nothing is
paused, bound workers continue, and no continuation or wake follows for work the host was already
shown. The next turn states the records as they are.

Pausing or cancelling a record takes the user's own confirmation naming it. The runtime reads the
user's latest message on the current branch and accepts only a whole line of the form `pause a2` or
`cancel a2` (several IDs may follow, `please` and a final period are allowed). It does not interpret
prose: a sentence that mentions stopping, a question or a negation confirms nothing. `host_work`
with `paused` or `cancelled` is refused without that line, whatever the call says, and the refusal
names the line to ask the user for. A confirmation stops each thing it names once; the record keeps
the last 16 uses, with the entry that carried each. `/assignments pause a2` and
`/assignments cancel a2` are the same authority given directly: the command applies the change to
that record without a model turn, keeps its recorded next step and tells the host at its next turn.
`task_control cancel` on a task that an open assignment of this session waits on is held to the same
rule: the line names the assignment, or the task by its ID or the first eight characters of it, and
then stops that task alone. A task no open assignment tracks is controlled as before, and so are
recurring schedules and coordinators, which stop their own tasks without this tool.
`task_control pause`, `revise_tasks` and `resume_task` stay available to the host for repair and
repartition: a paused task keeps its candidate and its assignment returns to the host. Unreadable
records refuse a cancellation instead of allowing it.

The rule follows the task across sessions. A task that advances an open assignment of another
session, in the same checkout, belongs to that session's record. Before `task_control` pauses or
cancels a task it did not bind, the runtime reads the records of the session that started the task
and of the one that last resumed it. If one of them waits on the task, the acting host needs the
user's line naming the task itself, `pause 1a2b3c4d` or `cancel 1a2b3c4d`. An assignment ID does not
reach across: `cancel a1` names the acting session's own `a1`. The use is recorded in the acting
session's ledger, which keeps the last 16, and stops the task once. The other session's records are
only read.

Automatic wakes that belong to no assignment, such as whiteboard requests, are parked only while
every open assignment of the session is paused. Pausing one assignment leaves the session awake for
the others, whichever record changed last.

A record is active (the host owns the next step), waiting (registered sources own it), blocked (a
visible dependency with its owner and resume condition), paused, done or cancelled. Waiting requires
a registered wake source: a tracked task of this session, in this checkout or another, or a run
registered with `watch_github_run`. A source that already finished leaves the assignment active, so
a result that arrives before its binding is never waited on. Outcome and target are fixed when the
record opens. Closing requires evidence naming that target and the delivered revision; evidence for
a preview, candidate or other target is kept as progress and cannot close. The runtime never closes
a record: a finished source hands it back to the host, which retains acceptance. A confirmed
cancellation requests cancellation of that record's running tasks, withdraws its watches and touches
nothing else.

Reconciliation uses no model call. While a record is open, a one-second pass reads each bound source
from its own registry and applies the result idempotently. Each finished delivery version counts as
one attempt, a resumed task re-arms its source, and a source unreadable three times is recorded as
unavailable. When every source of a waiting record has finished, the record returns to the host.

At settlement the host is asked to continue each active assignment it owns, and a run answers only
for what it was asked. A continuation answered with no action other than `host_work` stalls the
assignments that continuation named: each becomes blocked, says why and is not asked again. Any
other active assignment was never put to the host by that continuation, whether a source handed it
back while the run was under way or an interrupt left it active earlier, so it gets its own
continuation instead of the blocker. A run that ends in an error stalls the assignments its
continuation named and no others. An error in a run no continuation started belongs to the session:
every active record stays active, the user is notified, and each is offered to the host once more
after the first retry delay. A second error then stalls it through the continuation that names it.
One error streak never offers the same record twice.

A completed `documents` task is delivered by its supervisor. After the scope, document-type,
Markdown format and line-width checks pass and the candidate is applied, the supervisor records a
`delivery` receipt in the task state: the checkout, a revision over every applied path and its
content hash, and the hash and word count of up to eight files. The worker cannot write it. The
outcome message carries the receipt, and when an assignment's target is those documents in that
checkout the host closes on that revision without repeating the checks. For any other target the
receipt is progress. A resumed task has no receipt until it is applied again.

A wake is an offer, not a delivery. Pi starts a run asynchronously and reports a failed start only
to its error channel. The task feed, the run watch and the assignment desk therefore treat a
notification as delivered only when its receipt is persisted in the session. Until then an idle wake
is offered again after 5, 10, 20 and 40 seconds, five times in total, and a turn that is already
running appends it at its next boundary. A second copy of an outcome keeps its place in the
transcript and tells the model to take no action. If a result's own wake is lost entirely, the desk
wakes the host for the handed-back assignment after a ten-second grace period under the same bound.
When that is exhausted too, the record becomes blocked, the user is notified and the next turn
resumes it. Tasks bound to an assignment are delivered on any branch of the session and from any
checkout. Unbound tasks keep their originating branch; from another checkout they are delivered only
when this session dispatched them through a task tool, which records the route in the session. Run
watches belong to the session: a tree change no longer withdraws one.

Each turn starts with one compact statement of the open records; older statements leave model
context. `/assignments` shows the same records with their sources, attempts and evidence. A session
that recorded host work under the earlier latest-entry scheme has that entry carried forward when it
is next loaded: active and paused keep their state, a wait is bound to the task it names, and a wait
with no registered source becomes a visible blocked record. In-flight tasks and watches are never
cancelled by the change. Progress while Pi is closed and restart recovery are out of scope: a
session that is not running reconciles when it is reopened.

## Live worker observation and guidance

The host binds cross-checkout tasks through the [Workers origin registry](workers.md). The index
selects owner catalogs; it does not move state or expand file and tool permissions.

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
common-Git-directory merge lock serializes publication to main. Changed bases require fresh
executable checks. GitHub CI failures feed back into the task's orchestrator. Individual operations
remain bounded and cancellable; the branch orchestration service loop has no child-call, turn,
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

Local candidate repair prompts prioritize lint findings in the assigned files. The check receipt
keeps the full output. Inherited failures continue to block integration.

Each local accepted-design workflow has one project lock and no repair-round ceiling. Repeating an
identical failure with an unchanged candidate produces an actionable blocker. Commands, output size,
snapshot file count and size remain bounded. Database recovery verification is activated by the
checkpoint, changed persistence modules, SQL/schema files, database configuration or a worker's
explicit impact finding. Prose references outside configured DB paths do not trigger review.

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

Repository checks are trusted acceptance definitions. Their code executes inside the command
sandbox, or as local commands in a project the user enrolled as trusted-local. Review still needs to
detect meaningless tests, weakened assertions or benchmarks that measure the wrong boundary. Passing
commands alone does not establish durability, security or useful coverage.

## Database and performance scope

The recovery-check trigger disregards prose in leading JavaScript and TypeScript line comments. It
continues to inspect executable query text and both revisions of changed files. Explicit database
scopes and declared impact still require recovery checks.

Durability is evaluated against a stated failure model: process crash, host/disk loss, region loss
or malicious changes are different requirements. Replication does not substitute for backup and
tested restore. Sharding and replicas need a measured or availability-driven justification, with
consistency and recovery semantics reviewed explicitly.

The performance role writes benchmarks, opt-in instrumentation and reports. Default scope excludes
product code. Approved instrumentation paths are a capability grant; measurement work must preserve
product behavior. Tests verify disabled instrumentation behavior where such instrumentation is
introduced. Measured bottlenecks go to the implementer.

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
progress. Concurrent children are tracked by identity, not role, and the parent record points at the
running child with the most recent activity, never at one that finished. Periodic progress messages
enter context privately without waking an idle model. Optional `report_progress` summaries capture
meaningful findings or phase changes without mandatory chatter. A coordinator records its latest
`report_milestone` summary in its progress file. The host also recognizes an accepted workflow's
implementation handoff and a published branch awaiting merge. It batches new milestones by
originating session and branch, deduplicates using persisted message IDs, and groups subsequent
updates for up to a minute. An outcome or attention event can flush the batch earlier. Only a
material event wakes the idle host. A silent task gets one attention notice per unchanged activity
point, while completion and genuine blockers wake the orchestrator. It must inspect evidence,
resolve authorized host-only operations or report the actual external blocker; repeated identical
incapable workers are not a recovery strategy. Recovery first reconciles current project state and
user updates; work already completed directly must not be retried or overwritten from an old failed
candidate.

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
