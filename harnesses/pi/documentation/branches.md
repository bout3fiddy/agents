# Independent branch orchestration

The human-facing orchestrator can start autonomous branch orchestrators through `delegate_branches`
and immediately continue the conversation. Each branch orchestrator receives a settled design,
invariants, acceptance criteria and its own write scope. It delegates implementation to the
configured Astra role and reviews to Fable, consumes their feedback itself, and repairs failures.
Routine implementation, checks and repairs need no further approval. Publication is the default;
merging begins only when the user explicitly requests merging to main.

## Preparation and authority

Start Pi at the Git repository root. Commit and push a settled Markdown/text design document and the
required `.pi/harness.json` checks to remote `main`. The local design document must match that
remote revision; unrelated local edits are preserved. A design can reference other committed
documents. Supply only resolved decisions for the requested scope; future work can remain open.

`delegate_branches` accepts `designPath`, an optional remote name (default `origin`), and one to
four tasks. Each task has `task`, disjoint `writePaths`, `invariants`, `acceptance`, `database` and
`performance`. The optional `mergeToMain` flag defaults to false and may be set only for an explicit
user merge request. Otherwise `merge_branches` later authorizes merging of the published task IDs
and resumes their existing worktrees. Repeated merge requests are idempotent. All tasks in a batch
start from the same fetched main commit and pinned document contents. There is no `/accept-design`
checkpoint for this mode. Dependent tasks should share one orchestrator or execute in later batches.

The initial design is limited to 16,000 characters. Required test checks must exist before model
dispatch; database and performance tasks also require the corresponding project checks. GitHub
remotes additionally require an authenticated `gh` CLI with repository access and permission to
create PRs and publish branches. Provider authentication stays with the existing Pi/Claude setup.

## Execution

Each task gets a `pi/<task-id>` branch and worktree below the project's ignored trace directory. Its
Codex branch orchestrator receives explicit prompts from `prompts/branch-orchestrator.md` and
configuration from `roles/branch-orchestrator.json`. It can inspect files, call scoped workers, run
project checks and submit an outcome. It cannot perform Git publication or expand its scope.

Branch mode has no child-call, model-turn or overall-duration ceiling: zero values in its role
configuration mean unlimited. The coordinator continues until completion, a genuine blocker,
provider failure or cancellation. Individual worker and command timeouts remain enforced. Leaf calls
within one worktree execute serially; independent branch orchestrators run concurrently. The
ordinary local task coordinator retains its existing limits.

Passing results require executable checks and current engineering review on the exact candidate.
Database impact also requires database review and recovery checks. Performance tasks require
performance evidence and benchmarks. Later edits invalidate earlier snapshot evidence. Formatting,
test and review failures feed back into the autonomous orchestrator. No arbitrary repair-round
ceiling ends branch work.

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
verified issues and records reasons for rejecting false positives. Changed candidates pass internal
review/tests, then are committed and pushed for another external review. After at most five external
rounds, merging proceeds automatically with ordinary required checks still enforced. The round count
and consumed comment versions persist across head changes and restarts. An interrupted repair must
finish even if it was in the fifth round; exhaustion cannot bypass a repair already in progress.
This specific merge policy does not impose a call or turn limit on implementation orchestration.
After the review wait, the host refreshes CI and human-review status and checks for scoped updates,
cancellation or changed merge authority before allowing main publication.

A lock in the common Git directory serializes integration across local worktrees. The host fetches
current main, merges it into the candidate and refreshes review/tests when the base or contents
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

## Controls and evidence

`task_status` reports queued, running, checking, publishing, published, merge-queued, merging and
terminal outcomes. `task_control` can send a scoped clarification or cancel work. A scope expansion
requires a new task. Detached supervisors survive parent reload/exit; completion reaches the parent
once, including while idle. Publication and later merge each deliver a distinct acknowledgement.
Reload does not repeat either acknowledgement. Merge authorization while implementation is active
updates the existing task without starting another supervisor.

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

`npm run test:live:branches` runs real Codex/Astra/Fable orchestration against a temporary bare Git
remote. `npm run test:live:branches -- --github OWNER/REPO` requires an existing empty fixture
repository and additionally exercises PR creation, CI and remote main integration. The fixture
asserts parallel progress, foreground discussion, separate published branches with unchanged main,
an explicit later merge request, sequential refreshed merges, preserved original checkout,
completion acknowledgements and reload deduplication. Its 40-minute test deadline belongs to the
validation script and does not limit production branch orchestration.
