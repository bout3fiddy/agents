# Work Package Standard

Load this workflow when creating or executing work packages.

## Structure

Work packages live in `docs/workpackages/<task_type>_<name>_<date>/`.

- Folder name must include a task type prefix: `refactor`, `review`, `bugfix`, `migration`, or `feature`.
- `overview.md` is required — canonical rollup for all `WP-*` items (status, evidence pointer, next action).
- Additional markdown docs per work item are optional.

## Lifecycle

- Keep a linked Linear issue refined and traceable (scope, acceptance criteria, validation plan, and work-package path).
- Transition Linear lifecycle state as execution starts/completes.
- Treat repeated execution requests as continuation signals from the first non-done `WP-*` unless release criteria are already met.

## Execution Directive

Embed this block near the top of the primary entry file in each work package folder under `## Execution Directive (Standard)`:

```text
REQUIRED: Replace every <VARIABLE> placeholder before running this directive. Do not leave any <...> token unresolved.

start implementing fixes per work package: <WORK_PACKAGE_PATH_OR_DIR>

if a directory path is provided (for example `docs/review/workpackages_<name>_<date>/`):
- scan all markdown files in that directory
- read `overview.md` first (required canonical status summary)
- start from the primary entry doc (`overview.md` when present, otherwise first alphabetical markdown file)
- continue from the first non-done `WP-*` status across the directory

ensure changes are non-destructive.
the app is locally hosted at <APP_URL>, started via <APP_START_COMMAND>.
use playwright/browser tooling to validate runtime behavior and impact.

when each work package item is implemented:
- complete every checkbox in that WP's `## Completion Checklist` — each box must be checked (`- [x]`) individually; do not bulk-mark
- update that WP section with:
  - updated Recommendation rationale
  - Implementation status (YYYY-MM-DD)
  - Why this works
  - Proof / validation
  - How to test
- mark the WP title status line as [Status: Done YYYY-MM-DD] only AFTER all checklist boxes are checked
- update `overview.md` rollup row for that `WP-*` with status, last-updated date, proof pointer, and next action

a WP item is NOT done until every checklist box is checked. do not advance to the next WP until the current one's checklist is fully complete.

before every commit:
- stage only intended shipping files with explicit paths; never use `git add .`, `git add -A`, or `git add -f`
- inspect ignored state before staging (`git status --short --ignored` and `git check-ignore <path>` when unsure)
- do not stage `overview.md`, `wp-*.md`, scratch notes, or other workpackage tracking files unless the user explicitly asked to version them, repo instructions explicitly require them to ship, or this task is itself modifying workflow/workpackage docs
- confirm the staged set with `git diff --cached --name-only`

commit and push periodically as coherent checkpoints for shipping files only.

when all work packages are done:
- run the PR review remediation loop until:
  - all required checks pass
  - no new actionable review comments remain
- create a staging release
- only after staging release, update Linear issue <LINEAR_ISSUE_ID> with shipped outcomes and move it to In Review

this command may be repeated.
if staging release already exists for this work package, treat repeats as reminder signals and continue only unfinished steps.

default to hard cutovers; do not add fallback branches/shims unless explicitly approved with owner + removal date + tracking issue.
```

## Work Package Template

### Required folder layout

- `overview.md` (required): canonical progress summary and execution entry point.
- `wp-*.md` (optional but recommended): detailed per-item execution/audit notes.

### Required document structure

1. Title
2. `Execution Directive (Standard)` block
3. Metadata (created date, scope, input sources, constraints)
4. Background
5. Overarching goals
6. Non-goals
7. Work package items (`WP-01`, `WP-02`, ...)

### Overview summary requirements

`overview.md` must include a compact rollup table for all `WP-*` items with:
- `WP ID`, `Status`, `Last updated`, `Proof / validation pointer`, `Next action`

### Work package item template

Heading pattern: `### WP-XX <Short title> [Status: Todo]`

Each item must include:
- Issue, Needs, How, Why this approach
- Recommendation rationale
- Desired outcome
- Non-destructive tests
- Files by type (when useful for traceability)

#### Completion Checklist (required)

Every WP item MUST end with a `## Completion Checklist` containing at minimum these checkboxes:

```markdown
## Completion Checklist
- [ ] Implementation matches the described approach
- [ ] Non-destructive tests pass
- [ ] Proof / validation section filled with exact commands and outcomes
- [ ] How to test section is reproducible
- [ ] `overview.md` rollup row updated
```

Authors may add task-specific checkboxes (e.g. `- [ ] Migration tested against staging DB`). Agents MUST check each box individually as they complete the corresponding step — not in bulk at the end. A WP item cannot be marked `[Status: Done]` while any box remains unchecked.

### Accountability sections (required after implementation)

For each completed `WP-XX`, append:
- `Implementation status (YYYY-MM-DD)`: exactly what changed and where
- `Why this works`: causal explanation
- `Proof / validation`: exact commands run and key outcomes
- `How to test`: reproducible verification steps

After updating the detailed `WP-XX` content, update `overview.md` in the same change.

### Hard rule: checklist gates "done"

An agent MUST NOT mark a WP item as `[Status: Done]` or advance to the next item unless every checkbox in that item's Completion Checklist is `[x]`. If an agent cannot complete a checklist item, it must leave the box unchecked and note the blocker — the WP stays `[Status: In Progress]`.

### Version-control guardrails

During execution, `overview.md`, `wp-*.md`, and similar tracking docs are operational state by default. Keep them accurate locally, but do not include them in commits or PRs unless:
- the user explicitly asks for those files to be versioned
- repo instructions explicitly require those files to ship
- the task itself is updating the workflow/work-package docs/templates

Ignored files stay ignored. Never use `git add .`, `git add -A`, or `git add -f`; stage exact paths and verify the staged set before every commit.

### Resume semantics

1. Read status lines across all `WP-XX`.
2. Continue from the first non-done item.
3. Avoid redoing done items unless regressions are detected.
4. If staging release is already complete, report final state and stop.
