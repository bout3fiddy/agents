# Pi harness notes

Follow the repository [Tiger Style](../../TIGER_STYLE.md).

- Read `README.md` for installation and use, and `documentation/architecture.md` for the four
  decisions the design rests on. Read both before changing `src/job-*.ts`.
- `npm run verify` runs format check, lint, typecheck and the unit suite. Run it before every
  commit. `npm run test:live` runs one real job end to end with real models; run it after changing
  the runner, the worker entry points or the roles. It uses a disposable project.
- After a change that should reach the installed `pih`, run `npm run install:local` (or
  `./bin/sync-pi.sh` from the repository root). An idle interactive host reloads the extension
  itself; a Pi pin change needs a restart.

## Where things live

| Concern                               | File                                    |
| ------------------------------------- | --------------------------------------- |
| Jobs, events, held guidance           | `src/job-store.ts`                      |
| Commits, copies, apply, branches      | `src/job-git.ts`                        |
| The pipeline and the detached runner  | `src/job-runner.ts`                     |
| Job tools, `/jobs`, the delivery feed | `src/job-tools.ts`                      |
| Host file routing                     | `src/host-file-routing.ts`              |
| Worker process and its scoped tools   | `src/worker.ts`, `src/worker-tools.ts`  |
| Claude workers and their MCP bridge   | `src/claude-worker.ts`, `claude-tools`  |
| Sandbox and execution decision        | `src/sandbox.ts`, `worker-execution.ts` |
| Project checks and harness lint       | `src/project.ts`                        |
| Code mode                             | `src/inspection-mode.ts`                |
| Design advice                         | `src/workshop.ts`, `design-advice.ts`   |
| Whiteboard                            | `src/whiteboard*.ts`                    |
| Workers viewer                        | `src/workers-*.ts`                      |

## Rules for changes

- **Fix failures in code, in one place.** Name the invariant the failure broke and enforce it in the
  store, the Git layer or the runner. Add a prompt rule only for judgement code cannot make.
- **Replace, do not accumulate.** A fix that adds a mechanism removes the one it replaces in the
  same change. Do not add a second store, lock, journal, registry or delivery path.
- **No compatibility code.** Earlier state is never read or migrated. Raise `schemaVersion` when the
  store changes shape; the old file is set aside.
- **The runner owns the pipeline.** `job-runner.ts` selects the worker, runs checks and settles
  running jobs. Do not add a coordinating role.
- **Job control belongs to the owning host session.** Workers cannot cancel or retry. Preserve the
  user's `/jobs cancel` control and never automatically undo a user stop.
- **Keep the orchestrator's direct tools few.** A new host capability is a tool callable from code
  mode. Only the shell and host file writes are direct-only.
- **Optional features are separate extensions** that read the job store: schedules, extra viewers,
  integrations. They do not go into the runner.
- **Tests exercise the real path.** Runner tests use real Git repositories and the real check
  sandbox with a scripted worker. Feed tests use a real Pi session with a scripted model. Do not
  weaken a fixture to obtain a pass.

## Prompts and roles

- `prompts/shared.md` is prepended to every role. `roles/<name>.json` selects model, effort, tools
  and write scope. A role's `tools` list is its whole authority.
- The orchestrator prompt states policy. It must not restate what a tool description or the runner
  already guarantees.
- Keep the whiteboard section of the orchestrator prompt in step with `tests/whiteboard-prompt`.
