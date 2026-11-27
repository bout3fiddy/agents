# Workers across checkouts

The Workers picker includes the current project's workers and tasks launched from that project into
another checkout by the current host session. The launch context supplies the session's originating
directory and ID. Missing origin defaults to the owning checkout. Details show the owning project,
workspace and branch when recorded. The conversation, raw view, guidance mailbox and coordinator
remain in the owning checkout. Nothing here grants a worker additional file access or lifecycle
controls.

The private agent directory holds `worker-origins/<origin-hash>/index.json`. Each entry identifies
one canonical owner, task UUID and host session. No repository discovery is performed. The index is
limited to 128 entries and 128 KiB; owners are visited one at a time. Adding a relationship retires
entries confirmed complete for more than 30 days. Unreadable or active entries are not silently
evicted. A full registry rejects a new registration before its worker starts. A damaged entry
produces a warning rather than preventing observation of healthy tasks.

## Dispatch into another checkout

`delegate_task`, `task_status`, `task_control` and `resume_task` accept `project`, the absolute root
of another checkout or worktree. The task is registered in that project's own registry. Its write
reservations, concurrency limits, dependency check, `.pi/harness.json` checks and the user's worker
execution enrollment for that root apply unchanged. A path inside a `.pi` directory is refused: task
candidates are steered through their task. The origin index records the relationship for the picker,
and the dispatching session records the route in its own entries. A routed task's result reaches
that session like a local one. Steering a task there requires that this session started it. A task
ID from another checkout is a valid wake source for an [assignment](architecture.md#assignments),
which delivers its result on any branch of the session. A task that is only listed in the origin
index, without a route or an assignment, stays display-only. `task_control` cancels a task that an
open assignment waits on, in either checkout, only on the user's
[confirmation](architecture.md#assignments) naming that assignment or task. A task that another
session's open assignment waits on is paused or cancelled from this session only on the user's
confirmation naming the task.

The host shell is never the route. A worker started by hand has no registry entry, no reservation
and no completion delivery.

## Register existing tasks (host only)

From the originating project, run `register-worker-origin OWNER_ROOT TASK_UUID SESSION` using the
updated harness CLI. The equivalent API is
`await new WorkerRoots(new StateStore(origin)).register({ root: owner, taskId, session })`. It
validates the owning task and session before indexing. Older requests without an origin receive a
private origin receipt beside the request, not a modified request. Registration is idempotent. Do
not copy or link traces, rerun a supervisor or change the user's session.

After installation, replace the placeholders below and run in the host shell. This registers only
metadata for one existing task. The current working directory must be the originating project, not
the owning checkout or harness directory. After the CLI script, arguments must be in this exact
order: `register-worker-origin OWNER_ROOT TASK_UUID SESSION`.

```sh
origin=/absolute/path/to/origin-project
owner=/absolute/path/to/owning-checkout
h=/absolute/path/to/harnesses/pi
task_id=EXISTING_TASK_UUID
session=ORIGINATING_HOST_SESSION_ID
cd "$origin" || exit 1
node --import "$h/node_modules/tsx/dist/loader.mjs" "$h/src/cli.ts" \
  register-worker-origin "$owner" "$task_id" "$session"
```

Use the same `PI_HARNESS_AGENT_DIR` as the installed launcher for a nonstandard installation. Open
`/workers`, inspect the active children and compare details and transcripts to their owning
catalogs. Registration does not fabricate status. No restart, cancellation or guidance is required.
