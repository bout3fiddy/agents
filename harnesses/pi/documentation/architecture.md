# Architecture

The orchestrator is a Pi extension. Workers are fresh processes: the Pi SDK for Codex and Astra
roles, the Claude Code CLI for Claude roles. Four decisions carry the design. Each exists because a
class of failure kept recurring, and each makes that failure impossible by construction instead of
detecting it afterwards.

## 1. One transactional store

`src/job-store.ts`. One SQLite file per repository holds three tables: `jobs`, `events` (outcomes a
session has not been shown) and `messages` (guidance held for a job's next round). Host sessions and
detached runners open it concurrently in WAL mode. Every change is one transaction.

- A job cannot finish without an outcome event: `finish` writes both together.
- A job cannot be created twice by a looping script: `(session, key)` is unique.
- A script cannot flood the machine: creation fails beyond four active jobs.
- Two observers cannot both report a dead runner: `finish` acts only on an active job.

All checkouts of a repository use the primary checkout's store. There is no registry, lock file or
journal beside it. The schema has a version; a file written by another version is renamed aside and
a fresh one is created. Nothing is migrated.

## 2. Git records the work; copies do the work

`src/job-git.ts`. A job's starting point, latest state and result are commits held by private refs
`refs/pi/jobs/<id>/{base,wip,head}`. Commits are built with a temporary index, so the user's index,
HEAD, stash and working tree are never touched to record them.

- The base of an `apply` job is the working tree exactly as it stands: tracked and untracked
  authored files, without ignored, private or credential paths.
- Work happens in a disposable copy materialized from a commit, with the checkout's `node_modules`
  and `.venv` linked. The copy belongs to the runner process and is swept when that process exits.
- After every worker round the copy is recorded as `wip`. A retry, or a run after a dead runner,
  starts from it. Nothing has to be recovered from a directory.
- Delivery compares each changed path in the checkout with the base and the result. A path that
  holds neither is the user's concurrent edit: nothing at all is written and the result stays at
  `head`. Unrelated edits elsewhere do not block.
- `branch` delivery creates or fast-forwards a local branch with an expected-old-value update and
  refuses a branch that is checked out in any worktree.

A directory without Git gets a bare shadow store in its state directory and can only `apply`.

## 3. Control flow is code

`src/job-runner.ts`. One job type, one pipeline, run by a detached process per job:

```text
resolve base → copy → [ worker → record wip → scope check → host checks ]* → deliver
```

No model decides which worker runs, when checks run, or when to stop.

- Scope is checked on the bytes: every changed path must match the job's write paths, and a
  `documents` job may change only `.md`, `.txt` and `.rst`. A `research` job may change nothing.
- Only receipts from checks the host ran on the copy can pass an `implement` job. A worker's verdict
  cannot.
- A failed check returns to the same worker with its output. The loop ends when the same failure
  repeats on the same bytes or at the same locations, or after six failed rounds without guidance.
- A worker that reports `blocked` ends the run with its `hostActions`.
- Whatever happens, the run ends in `finish`: `done`, `needs_attention` or `cancelled`.

The runner writes a heartbeat every two seconds. A running job with a dead process and twenty
seconds of silence becomes `needs_attention`, found by any session's next read of the store.

## 4. Delivery is level-triggered

`src/job-tools.ts`. Nothing depends on a notification arriving.

- At every turn boundary, at settle and on a one-second idle tick, the feed reads the session's
  unacknowledged events from the store.
- At a boundary the outcome joins the running turn. While idle it starts one, repeated every ten
  seconds until it lands.
- An event is acknowledged only when its message is found in the session's persisted entries.
- Every turn starts with one statement of the session's open jobs; older statements leave context.
- A run that answers an outcome with nothing is asked once to act or name what blocks it.

## Authority

- **Stopping work is the user's.** `/jobs cancel jN` is the only way to stop a queued or running
  job. No tool available to the model cancels or pauses. The model may close a `needs_attention` job
  with a reason, and the user is shown it.
- **Product files change only through jobs.** A `tool_call` hook lets the host's own file tools
  write setup files, `.pi/harness.json`, small decisions in `design.md` and private scratch.
- **Isolation is the host's decision.** See [worker-execution.md](worker-execution.md).
  `isolation: 'required'` on a job narrows the project's execution decision for its worker and every
  check.
- **Publishing is a host shell action** taken on the user's request. Jobs never push.

## Code mode

`src/inspection-mode.ts`. Every orchestrator tool is callable from a `codemode` script except
`bash`, `write` and `edit`. Authority is enforced where the tool executes, not by which tools a
script may name: the store bounds job creation and no cancel function exists to call. See
[code-mode.md](code-mode.md).

## What is deliberately absent

Reservations, coordinators, a separate assignment ledger, pause and resume, recurring schedules,
retained candidate directories and compatibility with earlier state. Each was a mechanism for a
failure the four decisions above now prevent, or a feature that belongs in its own extension reading
the same store.

## Changing this design

When a failure is found, name the invariant it broke and enforce it in the store, the Git layer or
the runner. Add a prompt rule only for judgement the code cannot make. A fix that adds a mechanism
removes the one it replaces in the same change.
