# Independent branch orchestration

A write-scope conflict identifies the task holding the reservation or the earlier task in the batch,
along with the intersecting paths. Narrow the assignment or wait for the owner to release it.

The human-facing orchestrator can start autonomous branch orchestrators through `delegate_branches`
and immediately continue the conversation. Each branch orchestrator receives a settled design,
invariants, acceptance criteria and its own write scope. It delegates implementation to the
configured Astra role and handles failures within its scope. Routine implementation, checks and
repairs need no further approval. Publication is the default; merging begins only when the user
explicitly requests merging to main.

## Preparation and authority

Start Pi at the Git repository root. Commit and push a settled Markdown/text design document and the
applicable executable project checks to remote `main`. The local design document must match that
remote revision; unrelated local edits are preserved. A design can reference other committed
documents. Supply only resolved decisions for the requested scope; future work can remain open.

`delegate_branches` accepts `designPath`, an optional remote name (default `origin`), and one to
four tasks. Each task has `task`, disjoint `writePaths`, `invariants`, `acceptance`, `database` and
`performance`. The optional `mergeToMain` flag defaults to false and may be set only for an explicit
user merge request. Otherwise `merge_branches` later authorizes merging of the published task IDs
and resumes their existing worktrees. Repeated merge requests are idempotent. All tasks in a batch
start from the same fetched main commit and pinned document contents. There is no manual design
acceptance checkpoint for this mode. Dependent tasks should share one orchestrator or execute in
later batches.

The initial design is limited to 16,000 characters. Required test checks must exist before model
dispatch. The host validates the pinned commit once for the batch before registering tasks or
creating worktrees, and each runner rechecks the integration baseline. Database and performance
tasks also require their corresponding checks. See
[project check discovery](../README.md#project-checks). GitHub remotes additionally require an
authenticated `gh` CLI with repository access and permission to create PRs and publish branches.
Provider authentication stays with the existing Pi/Claude setup.

## Execution

Each task gets a `pi/<task-id>` branch and worktree below the project's ignored trace directory. Its
Codex branch orchestrator receives explicit prompts from `prompts/branch-orchestrator.md` and
configuration from `roles/branch-orchestrator.json`. It can inspect files, call scoped workers, run
project checks and submit an outcome. It cannot perform Git publication or expand its scope.

Coordinators and workers have no child-call, turn or overall-duration ceiling. Commands retain
timeouts. Independent branch orchestrators work concurrently in separate worktrees.

Verify the candidate with lint and behavioral tests. Use property tests for invariants and
deterministic simulation where timing, faults or recovery matter. Send a reproduced bug and its
failing check to the implementer, then rerun verification. Set performanceReview only when the user
asks for the performance specialist. A scoped benchmark check runs independently.

## Publication and merging

The host checks scope, Git identity and the reviewed bytes before committing. It disables Git hooks,
custom filters and merge drivers in these operations and verifies committed blobs and file modes
against the candidate. Remotes are pinned; changes to their configuration stop publication.

Each candidate is pushed to its separate remote branch. GitHub remotes get a PR and exact-head CI
checks. The adapter waits for pending checks, considers paginated statuses/checks/suites and allows
a registration grace before recording `none_reported`. Local required checks always remain
mandatory. Failed CI includes bounded logs in the orchestrator's repair input. External human review
objections remain repository-policy blockers and are never silently dismissed. A known previous PR
head gets up to 30 seconds to catch up after a push; an unexpected head still stops validation.

For an authorized merge, external automated reviewers follow a separate five-round policy. The host
detects current-head bot reviews, inline comments, review checks, requested reviewers and explicit
triggers. It also uses active review workflows and recent repository activity to allow a startup
window. If no reviewer is actually triggered, it continues without a model review loop. Observed
review duration guides a 2–10 minute wait, with five minutes as the initial estimate. Pending review
observation uses host polling and does not call a model.

Findings go to the branch orchestrator as untrusted claims. It checks whether each is valid, fixes
verified issues and records reasons for rejecting false positives. Changed candidates pass
executable checks, then are committed and pushed for another external review. After at most five
external rounds, merging proceeds automatically with ordinary required checks still enforced. The
round count and consumed comment versions persist across head changes and restarts. An interrupted
repair must finish even if it was in the fifth round; exhaustion cannot bypass a repair already in
progress. This specific merge policy does not impose a call or turn limit on implementation
orchestration. After the review wait, the host refreshes CI and human-review status and checks for
scoped updates, cancellation or changed merge authority before allowing main publication.

A lock in the common Git directory serializes integration across local worktrees. The host fetches
current main, merges it into the candidate and reruns executable checks when the base or contents
change. Scoped conflicts go back to the autonomous orchestrator; conflicts outside its authority
retain the branch for reconciliation. GitHub checks must pass on the resulting commit too.

The host advances remote main with a normal fast-forward push of that verified commit. Concurrent
remote changes trigger another update and validation cycle. It never force-pushes or bypasses branch
protection. Repositories that prohibit direct updates to main will reject this operation; their PR
and validated branch remain available with `needs_attention`. This version does not impersonate a
human approval or use GitHub's protected-branch merge queue. Repositories permitting these updates
receive the complete automatic workflow.

Remote main advances while the user's original checkout stays unchanged. Pull when appropriate
before further local implementation. Task branches and worktrees remain as evidence after merging;
automatic deletion is deliberately absent.

The branch coordinator receives the pinned design path at startup. Small design directories include
a list of committed document paths, including nested plans. Larger directories provide a search
prefix. These filenames aid discovery and confer no write authority.

When the sandbox denies the private IPC socket for an npm script invoking `tsx --test`, the check
receipt identifies the launcher error. The required gate stays failed. The project owner can verify
the declared command on the host or configure an equivalent `node --import tsx --test` command and
rerun the gate with the same test selection.

## Controls and evidence

A blocked branch delivers its coordinator’s requested host capabilities and reasons in the terminal
notification and task status. Resume clears active host actions and starts a separate receipt and
transcript. The resumed coordinator receives the previous attempt ID and host actions as history,
including when the host revised its assignment before resuming. Current host guidance and the new
candidate determine what still needs verification. During a coordinator run, a confirmed Claude
quota rejection with a future reset suppresses repeat launches of the same model. New host guidance,
a resumed coordinator, or the provider reset allows another attempt. Transient errors and usage
warnings retain ordinary recovery behavior.

`task_status` reports queued, running, checking, publishing, published, merge-queued, merging and
terminal outcomes. `task_control` can send a scoped clarification, pause or cancel work. A scope
expansion requires a new task. Detached supervisors survive parent reload/exit; completion reaches
the parent once, including while idle. Publication and later merge each deliver a distinct
acknowledgement. Reload does not repeat either acknowledgement. Merge authorization while
implementation is active updates the existing task without starting another supervisor.

Pause preserves the worktree and ownership. After acknowledgement, `revise_tasks` can replace task
instructions while retaining the pinned design and scope. `resume_task` restarts orchestration and
refreshes evidence invalidated by steering. Branch scope changes use replacement tasks; the host
must inspect retained work and dependencies before assigning a new owner. Published history is
preserved. Pause and eventual completion each produce a distinct parent notification.

Project-local `.pi/traces/harness/` contains:

- `worktrees/<task-id>/`: independent Git checkout and branch.
- `delegations/<task-id>/`: pinned design/request, controls, state, coordinator sessions, child
  receipts, validation snapshots, GitHub evidence, `agent-reviews.json` with triage history and
  round counts, and the final merge receipt.
- `baselines/`: baseline worktrees retained if validation cannot finish; successful baselines are
  removed after their evidence is saved.

Stopped supervisors and genuine blockers produce `needs_attention`; cancellation produces
`cancelled`. Inspect retained evidence before starting a replacement. The host does not blindly
replay a Git publication after an uncertain failure. Existing background local document tasks and
the accepted-design workflow continue to use their original integration paths.

## Validation

`npm run test:live:branches` runs real Codex branch orchestration against a temporary bare Git
remote. `npm run test:live:branches -- --github OWNER/REPO` requires an existing empty fixture
repository and additionally exercises PR creation, CI and remote main integration. The fixture
asserts parallel progress, foreground discussion, separate published branches with unchanged main,
an explicit later merge request, sequential refreshed merges, preserved original checkout,
completion acknowledgements and reload deduplication. Its 40-minute test deadline belongs to the
validation script and does not limit production branch orchestration.

For a branch in needs_attention, the merge tool returns the task ID and its recorded blocker.
Inspect review_receipts and recover the required checks on the intended head before merging.

## Local candidates

The host supplies the pinned base, current HEAD and Git cleanliness in the implementer's `checkout`
evidence. It checks the candidate worktree before each dispatch, including repairs. Use that
evidence for Git prerequisites in the worker sandbox.

Use `delegate_local` for a build on the current checkout. It pins local HEAD once, starts one direct
implementer per assignment in an isolated worktree and returns immediately. The host can continue
discussion and receive normal task outcomes. No remote, published design, project adapter or
coordinator is required. Uncommitted changes stay in their originating checkout. A detached HEAD
supports comparisons; local integration requires an originating branch.

For independent work, supply an objective, disjoint write scopes and an acceptance command per task
(or one common command). Example host tool input:

```json
{
  "mode": "independent",
  "objective": "Finish two public arithmetic operations",
  "tasks": [
    {
      "task": "Implement clamp",
      "writePaths": ["src/clamp.ts"],
      "acceptance": { "argv": ["node", "--test", "test/clamp.mjs"] }
    },
    {
      "task": "Implement stable deduplication",
      "writePaths": ["src/unique.ts"],
      "acceptance": { "argv": ["node", "--test", "test/unique.mjs"] }
    }
  ]
}
```

Independent work is the default when mode is omitted. Reserve `competition` for a hard unresolved
tradeoff. Supply `comparison.difficulty` and `comparison.criterion` at the top level, explaining why
another implementation is worth its cost and what evidence will decide. Give two to four candidate
approaches the same objective, a single top-level acceptance command and `acceptance.workloadPaths`
naming its committed drivers, config and fixtures. Use exact files or directory/**. Keep those paths
outside each worker's write scope. Candidates can edit the same product file in separate worktrees.
Include the relevant behavior in each assignment. The host owns comparison and selection; each
worker implements its assigned approach. Use a gate whose exit status tests the actual behavior. For
a performance comparison, make the pinned workload report the chosen metric and units. Wall time for
running a check includes overhead.

`compare_candidates` takes a batch ID and reports candidate outcomes and acceptance evidence. The
host selects a verified candidate based on the stated objective. `integrate_candidate` takes its
task ID, serializes integration against the originating local branch, and rechecks a changed base. A
competition can select one winner once the other candidates have stopped. Independent tasks can land
individually. Candidate commits and receipts remain inspectable after integration. Local integration
does not authorize publication. Continue to use `delegate_branches` for remote branch coordination
and GitHub checks.

Implementers and the on-demand performance specialist have `verify_loop` for seeded checks,
differential replay against the original, and paired benchmark measurements. Pass the seed to the
project's executable driver with `{seed}` in argv. Failure results retain replay arguments and the
snapshot identity. Final acceptance runs independently on the verified candidate.

Run `npm run test:live:local` for three real implementers on a local feature branch. Add
`-- --coordinated` to run the same assignments through the existing remote branch workflow in a
disposable bare Git repository. Both fixtures drive the host tool with a scripted Pi conversation.
