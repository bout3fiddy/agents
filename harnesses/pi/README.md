# Pi coding harness

At host startup and before work, Pi furnishes `TIGER_STYLE.md`, its Apache license and a root
`AGENTS.md` link offline, in the Git worktree root or the current non-Git directory. The bundle in
`guidelines/` adapts TigerBeetle’s guide; its revision is a provenance reference, not a byte pin. No
model is invoked by setup. Before implementation the host replaces the pending section with verified
local rules and checks. Workers read it without managing it. Existing content stays owned by the
repository: reconcile it manually after material changes. A missing guide is restored as pending.
Resolve conflicts, unsafe paths or filesystem errors before continuing. If an interrupted setup left
`.pi-tiger-style.lock`, confirm no setup is active before removing the empty directory.

Codex workshops designs with the user and parallel Fable advice. It has shell and file tools for
investigation, setup and acceptance. Every product change runs as a background job: one worker in an
isolated copy, checks run by the host, then delivery. The conversation continues meanwhile.

On Apple silicon Macs with Paper Desktop in `/Applications`, start Paper and use `pih` normally. Pi
and Claude sessions discover Paper’s native tools without selecting a task. In Pi, `/mcp` shows
Paper’s connection and tool count. If Paper is absent or isolation is required, it is not added.

In the host editor, **Enter** sends when idle and **steers** while working. A steer reaches the
model after the in-flight response and its tool batch, before the next model request. It does not
cancel a tool or undo its effects. `/steer TEXT` explicitly uses the same delivery priority. After a
busy **Enter**, look for `Steering:` above the editor. Pi shows the configured shortcut to edit
**all** queued messages there. That bulk action clears the queue and restores the listed messages to
the editor; it does not withdraw just the last steer.

**Alt+Enter** (Option+Enter on macOS, or your configured follow-up key) interrupts the foreground
run. With editor text, it requests cancellation at once and sends that text as the next turn after
the run stops. With an empty editor, it sends the first pending human steer, otherwise the first
human follow-up; with neither, it explains and cancels nothing. Unlike Esc, it leaves other queued
and extension messages in their order and delivery mode. `Interrupting with:` above the editor shows
the held correction until the run settles. A tool that ignores cancellation keeps it waiting; no
second turn starts and repeated presses change nothing. Completed effects are not undone, and
background tasks continue. A correction that cannot be sent returns to the editor, or to the front
of its queue. When idle, Alt+Enter sends like Enter. Pending steers arrive together by default; an
explicit one-at-a-time steering preference still applies.

The editor’s working indicator shows the latest streamed reasoning caption on one line and clears
when idle. The installer sets transcript thinking to collapsed. Use Pi’s thinking display toggle if
you want the full reasoning blocks; neither display mode changes the saved session.

`/start_whiteboard` opens this conversation’s tldraw-sync board. Use the iPad URL or scan the QR on
its Mac stage; keep the stage open for snapshots and previews. On iPad, optionally type a note
saying what you want, then tap **Send**. Only the owning host receives the request. It answers in
the conversation, or previews and publishes a freeform scene to the one Agent canvas. It can inspect
outstanding work with `whiteboard status`. Only the human can replace Sketch. The listener resumes
on reload; `/stop_whiteboard` detaches without stopping the shared daemon. pih, the tldraw-sync CLI
and its daemon must all speak protocol 3; a mismatch names the version each one reports. Start
explicitly in a new or forked session. Use a trusted LAN. Install `tldraw-sync` on PATH, set
`PI_WHITEBOARD_BIN`, or install Bun with a sibling `tldraw-sync` checkout next to the project root.
See the [whiteboard integration check](documentation/whiteboard.md) for the paired Mac/iPad journey.

| Role                     | Model / default effort |
| ------------------------ | ---------------------- |
| Orchestrator             | Codex / medium         |
| Implementer              | GPT 6.2 Astra / medium |
| General task worker      | GPT 6.2 Astra / medium |
| Design advisor           | Fable 5.2 / medium     |
| Performance investigator | Fable 5.2 / medium     |

Fresh installs default to `openai-codex/gpt-6.2-astra` at medium effort. Pi's current model and
thinking selection take precedence for the orchestrator; the harness never silently changes them.
Change `roles/*.json` to select models, effort, tools and write scopes. Astra implements by default;
when you ask for Opus or Fable the orchestrator sets `implementerModel` on that job. Claude roles
prefer Fable 5.2 and fall back to Opus on a confirmed usage limit, reported with the result.

## Jobs

A job is the only way product files change. The orchestrator starts one with `job_start`:

| Field        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `mode`       | `implement` (code), `documents` (Markdown and text) or `research` (read-only) |
| `writePaths` | Exact files, `directory/**` or `**`. The host checks them on the actual bytes |
| `design`     | Optional settled design for an implement job                                  |
| `deliver`    | `apply` writes into the working tree; `branch` commits on a local branch      |
| `base`       | Commit to start from. Default: the working tree as it stands                  |
| `isolation`  | `required` keeps the job sandboxed whatever the project trusts                |
| `key`        | Idempotency key: the same key in one session returns the first job            |

What the host does for every job, in code and never by a model's decision:

1. Record the starting point as a Git commit: the working tree exactly as it stands, uncommitted and
   untracked files included, without touching your index, HEAD or stash.
2. Give one worker a disposable copy and the assignment.
3. Check on the actual bytes that every change is inside the write scope.
4. Run the project's checks on the copy. A failure goes back to the same worker with the output. The
   loop stops when the same failure repeats, or after six failed rounds.
5. Deliver: apply to the checkout, or advance the branch. A path the checkout changed meanwhile is a
   conflict; then nothing is written and the verified result stays available as a commit.

Jobs do not reserve files. Up to four run at once; overlapping results collide at delivery.

Outcomes reach the conversation on their own. At every turn boundary and idle tick the host reads
which outcomes the session has not been shown and offers them; an outcome counts as delivered only
once its message is in the session transcript. A wake that is lost is offered again. Each turn also
starts with the recorded state of the session's open jobs.

| You type           | Effect                                                     |
| ------------------ | ---------------------------------------------------------- |
| `/jobs`            | List recent jobs                                           |
| `/jobs j12`        | Show one job in full                                       |
| `/jobs cancel j12` | Stop it. Its work so far is kept as a commit               |
| `/workers`         | Browse live workers and their conversations, send guidance |

Only you can stop running work. The model has no cancel tool. It can guide a running job
(`job_message`), retry a stopped one from the work it kept (`job_retry`) or close a stopped one with
a reason (`job_close`), and you are shown every closure.

A job that stops is `needs_attention` with the reason: a blocked worker and the host actions it
asked for, failing checks, an edit outside scope, a delivery conflict, or a runner that died. A dead
runner is detected from its heartbeat, and a retry continues from the last recorded commit.

Pushing a branch, opening a PR and merging are host shell actions the orchestrator takes only on
your request. A CI failure on a job's branch is repaired by another job on that branch.

## Code mode

`codemode` runs one JavaScript script that calls many tools, chains their results and returns only
what matters. Every orchestrator tool is callable from a script except `bash`, `write` and `edit`,
so a single step can start several jobs, read their status, search and read files and inspect PRs.
Workers script their read-only inspections. See
[documentation/code-mode.md](documentation/code-mode.md).

## Shell activity in the terminal

Consecutive host shell calls for the same pull request, check or host operation share an activity
row. It shows the call count, running work, failures and confirmed outcomes. Click its title for the
individual calls, then click a call for its original command and combined output. Pi’s expand-tools
shortcut (Ctrl+O by default) opens raw details throughout the transcript. The same view is available
when resuming a session. Routine host bookkeeping stays hidden. Other tools use a single activity
row with failures visible. Click a row or use Ctrl+O for labeled arguments and results with indented
JSON. Blockers still show the condition for resuming work.

Exercise the terminal view with `uv run --with pexpect --with pyte scripts/check-shell-terminal.py`.

## Install and run

Requires macOS, `sandbox-exec`, Node 22.19+, Python 3.10+, and Claude Code with `--setting-sources`,
`--tools`, `--strict-mcp-config` and `--system-prompt-file`. Development was verified with Pi 1.5.2
and Claude Code 2.1.326.

```sh
cd harnesses/pi
npm ci --ignore-scripts
npm run verify
npm run install:local
npm run doctor
```

From a project directory:

```sh
~/.pi/agent/bin/pi-harness
```

The launcher uses the harness's own Pi dependency and disables ambient extensions, skills, prompt
templates, context discovery and MCP. Ordinary `pi` also loads the installed role extension; the
dedicated launcher supplies the full isolation flags even if other global Pi packages are installed
later. When quitting the launcher, use the printed command from the same project: it quotes the
installed wrapper and selects the exact saved session, without looking up `pi` on `PATH`. If you
follow an older `pi --session ...` hint, the installed extension warns when the CLI is not the
expected launcher or release. Exit normally and use the warning’s command. Nothing is upgraded or
restarted automatically. A global Pi without the harness is unchanged.

### Update Pi

The launcher’s Pi release banner names the wrapper’s `update` command. A bare `pi update` manages a
separately installed global Pi, not the harness. To update the harness explicitly:

```sh
~/.pi/agent/bin/pi-harness update          # latest release
~/.pi/agent/bin/pi-harness update 1.5.2    # a specific version, or a rollback
```

The updater changes the exact Pi SDK and TUI pins in `package.json` and `package-lock.json`
together, runs `npm ci`, then runs typecheck and tests. If installation or validation fails, it
restores both files and the previous `node_modules` tree. Review and commit the pin files together;
the updater does not publish changes or alter existing jobs' pinned snapshots.

Run the update in the canonical primary checkout. If the launcher points to a deployment worktree,
run `npm run update:pi` from the primary checkout's `harnesses/pi` directory instead (append
`-- 1.5.2` to select that version). Save or stash edits to either pin file first. Close harness
sessions and let background workers finish before replacing their shared Pi installation. `--force`
skips only the running-process check. After accepting the new pins, sync the intended release so its
install receipt reflects them. Restart open sessions through that wrapper to load the new Pi.

Authenticate independently when needed:

```sh
pi auth login openai-codex
claude auth login
```

Claude workers use `claude --dangerously-skip-permissions`, exactly the user's `clod` alias. A shell
alias is not executable by subprocesses, so the adapter passes its flag explicitly. No permission
dialog is expected inside workers. WebSearch and WebFetch provide public research; command/file
tools use the scoped MCP bridge.

## Design workshop and routine work

Use a design consultation for an explicit second design opinion or a consequential choice still open
after checking the evidence. Operational reconciliation uses source and receipts. The host handles
requested code reviews. Reuse advice for settled choices, quiz presentation and mechanical edits.
Codex quotes the user's wording separately from its own proposal and develops its own answer while
Fable runs. These routing rules are prompt policy, exercised by the live workshop scenarios; they
are not a semantic authorization gate.

Fable receives up to twelve recent user messages, selected documents, folder instructions and
confirmed context. `historyMessages` can select 0–12; omitted history is counted explicitly. Supply
necessary older constraints in `context`. Whole files are limited to 16 KB each; use `excerpts` with
`path`, `startLine` and `lines` (up to 160) for larger documents. Total input is bounded at 48 KB;
oversized inputs fail explicitly. Advice targets 350 words, or 700 with `depth: "deep"`. Output
budgets are instructions, with the existing 32 KB hard response limit retained. Each consultation
uses a fresh Claude instance with WebSearch/WebFetch and explicit prompts. It has no local
execution/file tools, ambient global instructions, skills or memory.

Ready advice is consumed at the next completed model/tool boundary, or triggers a response when Pi
is idle. Codex presents each view, agreements, disagreements, constraints and choices for the user.
`design_consultation` can inspect metadata, await or cancel a job. Automatic delivery and explicit
waits share a persisted consumption record, including waits made after Fable finishes. Advice from
an earlier user request is saved as superseded and does not automatically interrupt the newer
discussion. Waiting consumes the result once; interrupting a wait keeps the background consultation
running. Use explicit cancellation to stop it. There are at most two active consultations; each has
no model-turn or elapsed-session cap. Session shutdown, replacement, reload and tree changes cancel
pending advice. Results and inputs live in the project's private harness state under
`consultations/`. Resuming can inspect a saved result; an abandoned running job must be restarted.

The orchestrator owns setup, Tiger Style customization and acceptance. In a fresh directory it
creates the starter README, ignore files and formatting manifest and runs the install and check
itself. Its file tools otherwise write only `design.md`, `design/design.md`, `.pi/harness.json` and
private scratch under `.pi/traces/scratch/`; everything else is a job. The host shell is
unrestricted and must not be used to bypass that. A Git commit requires your authorization.

By default worker commands are sandboxed with no network or home access. In a project you enroll as
trusted-local they run as normal local commands with your authority, which is a statement of trust
and not containment. See [documentation/worker-execution.md](documentation/worker-execution.md).
Workers return structured `hostActions` when they need a capability only the host has.

## Automatic harness updates

A Git push alone does not run the local installer. After publishing, sync the intended checkout with
`./bin/sync-pi.sh` (or `npm run install:local` in `harnesses/pi`). The installer writes the wrapper,
settings and finally `harness-install.json`. New wrapper processes use that installation.

An interactive host checks the completed local receipt every three seconds. For a changed build in
the same source directory with the same Pi host, it reloads the extension at the next idle point. An
unsent draft, queued work, open worker picker or pending design consultation defers reload. Reload
does not replace the running CLI or its launcher code. A different release directory or Pi pin needs
a process restart, even if the extension hash is identical. The host shows a restart command rather
than claiming to have switched releases. A process predating launcher detection needs one normal
exit and restart through the installed wrapper. Detached workers keep their build.

## Verify the loaded runtime

Run `/harness-version` to inspect the currently loaded version, Git revision, source digest, load
ID, load time, startup/reload reason and actual tool inventory. `piHost` records the observed CLI
entry and its package version, if identifiable, separately from the loaded harness source and the
install receipt’s `expectedPi`. A missing host version is unknown, not the extension SDK version.
The footer shows the harness version and short digest; Each session records these receipts in
`.pi/traces/harness/runtime/<session-id>.jsonl` and its raw trace. Request timing references the
load ID. Compare the source digest with `~/.pi/agent/harness-install.json` after an installation.

Code identity and orchestrator prompt/tool policy are captured for the loaded generation. Editing
files on disk cannot relabel the running process. `/reload` activates the new generation and records
a fresh load ID with reason `reload`; it preserves conversation and background jobs.

## Project checks

Pi reads the project's check configuration when a job starts. An explicit `.pi/harness.json` takes
precedence. Without it, each row below uses the first executable npm script present in the listed
order. Receipts still require the command to run and pass.

| Check kind   | npm scripts                          |
| ------------ | ------------------------------------ |
| General test | `test`, `test:unit`, `test:scaffold` |
| Static       | `verify`                             |
| Database     | `test:database`, `test:recovery`     |
| Benchmark    | `benchmark`, `test:performance`      |

A generic `check` script can combine arbitrary steps and does not establish test coverage by itself.
Designs that declare database or performance work require their respective check kinds. Use an
adapter for other command names or custom timeouts. Example:

```json
{
  "checks": [
    {
      "id": "contract",
      "argv": ["npm", "test"],
      "kind": "test",
      "required": true,
      "timeoutMs": 120000
    },
    {
      "id": "types-and-lint",
      "argv": ["npm", "run", "verify"],
      "kind": "static",
      "required": true,
      "timeoutMs": 120000
    }
  ],
  "databasePaths": ["db/**", "migrations/**", "storage/**"],
  "instrumentationPaths": ["src/instrumentation/**"]
}
```

Allowed check kinds: `test`, `static`, `database`, `benchmark`. Commands are argv arrays; shell
expansion requires an explicit shell. By default they run in the worker sandbox with no network,
private home access or credential environment. In a project enrolled as trusted-local every check
and benchmark runs as a local command in a disposable copy instead. Install dependencies beforehand.
Host `node_modules` and `.venv` are linked read-only; a virtual environment's interpreter prefix is
also readable. Each command copy has a Git index of its files and, for a checkout, its pinned HEAD,
so read-only `git ls-files`, `git diff` and `git rev-parse` work.

Set `"runner": "host"` on a check that needs a database server, browser, loopback listener, Docker
or process control. Host checks run outside the sandbox in a disposable copy of the exact snapshot,
with the user's normal permissions and a minimal environment (`PATH`, `HOME`, `USER`, Docker
variables). They form the final gate with harness lint: both run once, after every sandbox check
passes. Earlier repair rounds therefore see only behavioral failures. Under required isolation a
`runner: host` check is reported unavailable and is not run. A benchmark's `runner` never selects
the host; only trusted-local enrollment does. Harness lint compares its findings with the base
commit's findings by file, message and line text. Existing findings are listed in
`inheritedLintPaths` and never block; only findings the task adds do.

Starting an implement job fails when host `node_modules` does not match the direct dependencies
pinned by `package-lock.json`. Run `npm ci` on the host and start it again.

Worker changes to `.pi/` are forbidden. New paths ignored by the project's Git policy are rejected
before delivery. Required checks with truncated output fail; use concise summaries when a suite is
verbose.

## State

Everything is project-local under `.pi/traces/`, ignored through `.pi/.gitignore`.

| Path                           | Content                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `harness/jobs.db`              | Jobs, undelivered outcomes and held guidance (SQLite)   |
| `harness/jobs/<id>/`           | Worker requests and results, check receipts, runner log |
| `harness/workers/<id>/`        | One worker's metadata, state and conversation           |
| `harness/consultations/`       | Design advice inputs and results                        |
| `sessions/`                    | Pi conversations                                        |
| Git refs `refs/pi/jobs/<id>/*` | Each job's base, latest work and result commits         |

All checkouts of one repository share the primary checkout's store, so a job started for another
worktree is visible from any session of that repository. A directory without Git keeps its commits
in `harness/shadow.git`. State written by another schema version is set aside as `jobs.db.vN` and
never migrated. Temporary copies belong to the process that made them and are swept once it exits.

## Separation from other harnesses

Pi installation writes only `~/.pi/`. `bin/sync.sh` preserves the existing Codex instruction/skill
installation. Claude global cleanup is a separate, explicit operation under `../claude/`; Pi
supplies its Claude workers' prompts at launch. Pi installation never rewrites canonical `SKILL.md`
content or `instructions/global.md`. Repository-wide lint also covers the executable skill scripts;
formatting changes to those scripts preserve their behavior.

### GitHub Actions follow-up

When a pending Actions run gates the next step, the orchestrator uses `watch_github_run` to save the
repository, run ID and intended follow-up in its session. Pi checks GitHub every 30 seconds while
that conversation is open and wakes it at idle with the conclusion, commit and attempt. A watch
belongs to its session, on any branch of the conversation tree, and a wake is repeated until the
session has recorded it. Reopening the same session restores outstanding watches. Three consecutive
lookup failures wake the host with a diagnostic. The host retains its existing permissions for any
subsequent action.

For a PR merge, pass its number and expected head in the watch's `pullRequest` field. A changed
head, conflict or closed PR wakes the session even while the old run is pending. Query `inspect_pr`
with `includeQueue: true` to distinguish verified GitHub queue membership from a local watch.
Ordinary inspections keep their single GitHub query. If a run stops gating your task, the host can
call `watch_github_run` with `action: "cancel"`, repository and run ID. Cancellation survives reload
and leaves the remote workflow running. An optional PR pin limits cancellation to that candidate.
