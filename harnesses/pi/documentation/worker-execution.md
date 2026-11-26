# Worker execution policy

Worker-issued commands run one of two ways: as normal local commands, or inside the command sandbox.
The user decides which, per project, and the host records that decision outside every project.
Workers, project files, prompts and tool arguments can add isolation but can never remove it. The
sandbox is configured software behind the existing tools. No worker tool selects it, and a host
dispatch tool can only require it.

## Modes

- `trusted-local`: the user enrolled this exact project root. Commands run as local commands.
- `isolated`: no decision is recorded. This is the default. Commands run in the sandbox.
- `required-isolation`: the user, the host process or the host task demands it. Commands run in the
  sandbox and nothing runs on the host.

The modes are ordered from least to most isolated. Whenever two decisions meet, the more isolated
one applies.

A project nobody enrolled behaves exactly as before this policy existed: commands are sandboxed and
a check the project adapter marks `runner: host` still runs on the host. `required-isolation`
removes that last route as well.

## Recording a decision (host only)

Run the harness CLI from the project root. `h` is the installed `harnesses/pi` directory.

```sh
h=/absolute/path/to/harnesses/pi
cd /absolute/path/to/project || exit 1
cli() { node --import "$h/node_modules/tsx/dist/loader.mjs" "$h/src/cli.ts" "$@"; }

cli trust                     # show the decision in force
cli trust trusted-local       # enroll: normal local commands
cli trust required-isolation  # always sandbox this project
cli trust unknown             # forget the decision; back to isolated
```

Each form prints the project, the registry path and the resulting decision. The registry is
`harness-trust.json` in the private agent directory (`~/.pi/agent`, or `PI_HARNESS_AGENT_DIR`),
written atomically with mode `0600`. It holds at most 256 projects in 256 KiB. Concurrent recordings
are not serialized; the last one wins.

Enrollment names one canonical directory. A child directory, a copy, another checkout of the same
repository or a path that does not resolve is unknown and stays isolated. Task worktrees below an
enrolled project use that project's decision, because the decision follows the project root the host
dispatched from, not the worktree path.

Enrolling is a statement that you trust the code in that checkout and the changes workers make to
it. Do not enroll a repository you would not run `npm test` in yourself.

## Requiring isolation

Any one of these is enough, and none can be overridden from below:

- **Project:** `cli trust required-isolation` in that project.
- **Host process:** start the host with `PI_HARNESS_ISOLATION=required`. Every project it dispatches
  is isolated, enrolled or not. Any other non-empty value is rejected rather than interpreted.
- **Host task:** `isolation: 'required'` on the tool call that starts the work.

### Per-task isolation

The host sets `isolation: 'required'` when a design, its inputs or the material a task reads are
external or untrusted. The field exists only on host tools and accepts only that value; an omitted
field adds nothing and no value lifts isolation the project or host process demands.

- `workflow`, field `isolation`: the pinned scope, with its implementer, checks and benchmarks.
- `delegate_task`, field `isolation`: the coordinator, its children and its checks.
- `delegate_local`, field `isolation` for the whole batch: every candidate, its acceptance and the
  checks run again at integration.
- `delegate_branches`, field `isolation` for the whole batch: every branch task, its children,
  checks and merge-time refresh.
- `recurring_task`, field `definition.work.isolation`: every occurrence, audits included.

The requirement is stored in the task's `request.json` and read by every runner, so it survives
reload, `resume_task`, `revise_tasks` and `merge_branches`. `workflow` also records it on the pinned
scope: calling `workflow` without a design resumes that scope with the same isolation, and the CLI
`run` command honors it. A coordinator hands its children the narrowed decision, research swarm
members included. `task_status` shows `isolation` on each task that carries it.

A stored value other than `required` stops the task with an error. It is never read as "not
isolated".

## How a decision is applied

The host resolves the decision when it loads the project and freezes it into each worker request.
Before every command the worker resolves the host's current decision again and uses the stricter of
the two. Consequences:

- A request that claims trust for a root the host never enrolled runs isolated.
- A task the host marked `isolation: 'required'` stays isolated in an enrolled project.
- Revoking trust, or setting the host requirement, takes effect on the next command of a running
  worker.
- Granting trust never reaches a worker that was dispatched isolated; dispatch again.

The project adapter `.pi/harness.json` is a repository file. It has no execution field and an
unknown field is rejected. Under `required-isolation` a check it marks `runner: host` is reported
`unavailable` with the reason; it neither runs on the host nor passes unrun.

A malformed registry, an invalid `PI_HARNESS_ISOLATION` or a malformed stored decision stops
resolution with an error. Nothing defaults to a less isolated mode.

## No fallback

When the sandbox cannot start, the command fails and reports it. That covers platforms other than
macOS and `sandbox-exec` nested inside another sandbox. `run_command` returns the failed result with
an `isolation` note, and `verify_loop` reports `blocked`. Nothing retries on the host.

Every command result records `runner` (`sandbox` or `host`), and worker evidence records the
decision in force at submission.

## What trusted-local changes

`run_command`, `verify_loop` and project checks run argv directly, still in a disposable copy of the
candidate, with these properties:

- Installed dependencies, loopback listeners and network behave as in the checkout.
- The environment is a short allowlist (`PATH`, `USER`, `LOGNAME`, `SHELL`, Docker settings) plus
  the user's `HOME`, a private `TMPDIR`, `CI=1` and `NO_COLOR=1`. Other variables of the host
  process, including provider tokens, are not passed and so cannot appear in captured output.
- Timeouts, cancellation and process-group cleanup are the same code as sandboxed commands.
- Writes in the working directory land in the copy and are discarded. Retained edits still go
  through the scoped file tools.
- After each command the tool compares the candidate with its state before the command and undoes
  changes to paths outside the assignment, reporting them as `restoredCandidatePaths` with an error
  result. Host verification still checks scope and snapshot independently.

The restore step attributes every change outside the assignment that happens during a command to
that command, and never touches an assigned path. It cannot undo a legitimate edit, because
legitimate edits only land on the assigned paths of the one worker that may write a candidate:

- A writer holds its candidate alone. The coordinator serializes its children and its own tools, and
  each local or branch candidate has its own worktree.
- The only workers that share a candidate are research swarm siblings. They are dispatched with an
  empty write scope, so their file tools retain nothing, and a swarm never overlaps a writer.
- Siblings can undo each other's stray command writes in either order. The coordinator compares the
  candidate before and after a swarm and rejects one that left it changed.

Dispatching a writer beside another worker on one candidate would break this and needs a different
safeguard first. `tests/execution-dispatch.test.ts` holds the invariant.

Harness lint always runs in the sandbox. Benchmark checks follow the same decision as other checks:
a trusted-local project measures as a local command, every other project measures in the sandbox,
and both receive the nested dependency trees described below. A benchmark's `runner` field has never
selected the host and still does not. A sandbox that cannot start fails the benchmark.

### What it does not protect

`trusted-local` is not a containment boundary. A local command has your file, network and process
authority. It can read credential files in your home directory, write anywhere you can, including
the registry itself, and start processes that outlive it. The restore step above catches accidental
writes to the candidate; it does not observe paths excluded from snapshots (dependency directories,
`.env` files, private harness state) and cannot stop a process that writes later. Scoped retained
writes, the disposable candidate, check receipts, host publication and independent acceptance are
unchanged, but under `trusted-local` they guard against mistakes, not against hostile code.

For work you do not trust, use isolation. The sandbox limits are described in
[architecture.md](architecture.md).

## Nested dependencies

A command copy has always linked the project's root `node_modules`. A package below the root with
its own `package-lock.json` now also gets its installed tree linked from the project root the host
dispatched from, in both modes, so tests there resolve the versions that lockfile pins.

- A tree is linked only when the direct dependencies it holds match the lockfile in the copy.
- A tree that differs stops the command with the mismatches and the `npm ci` location to hand to the
  host. Skipping the link would let resolution climb to a parent tree and load another version.
- A lockfile without an installed tree is not linked. Imports of what it pins then resolve through
  the trees above the package. Where the nearest such tree holds a pinned dependency at another
  version, the copy gets a guard package of that name inside the uninstalled package: `require`,
  `import` and the dependency's commands fail there with the `npm ci` location, instead of loading
  the other version. The guard exists only in the command copy.
- An uninstalled package whose pins nothing above it contradicts is left untouched, and commands
  that never import a guarded dependency from that package run unchanged. More than 256 guarded
  dependencies in one copy stop the command.
- Under isolation a tree is readable and never writable, and one that resolves outside the project
  is refused. A trusted checkout may link its dependencies wherever it keeps them.
- At most 64 nested trees are linked per copy.

Workers still cannot install dependencies. Under `trusted-local` an install command would write
through the link into the host tree; treat installation as a host action.

## Verification

`tests/worker-execution.test.ts` covers the decisions with Node built-ins only, so it runs inside an
isolated candidate copy without installed dependencies:

```sh
node --experimental-strip-types --test harnesses/pi/tests/worker-execution.test.ts
```

`tests/execution-dispatch.test.ts` drives the host tools through a real Pi session and each stored
task through its runner: per-task isolation on every route, resume and revision, scheduled work,
coordinator children, the restore invariant and the benchmark route.

`tests/verification-loop.test.ts` and `tests/worker-lifecycle.test.ts` drive the real worker tools,
the host check route and the Claude MCP bridge. Their loopback, host-runner refusal, cancellation
and timeout cases need an unsandboxed host with a working `sandbox-exec`; run them with `npm test`
from `harnesses/pi`. With `PI_HARNESS_ISOLATION=required` set in that shell, existing tests that
expect a `runner: host` check to run will fail by design.
