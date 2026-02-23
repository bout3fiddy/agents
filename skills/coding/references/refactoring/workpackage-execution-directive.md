---
description: Standardized execution directive block for implementing refactoring work packages with resumable progress and release closure criteria.
---

# Refactoring Work Package Execution Directive

Embed this block near the top of every refactoring work package file under:

`## Execution Directive (Standard)`

```text
start implementing fixes per work package: <WORK_PACKAGE_PATH>

ensure changes are non-destructive.
the app is locally hosted at <APP_URL>, started via <APP_START_COMMAND>.
use playwright/browser tooling to validate runtime behavior and impact.

when each work package item is implemented:
- update that WP section with:
  - updated Recommendation rationale (coding rules + smell mitigation references)
  - Implementation status (YYYY-MM-DD)
  - Why this works
  - Proof / validation
  - How to test
- mark the WP title status line as [Status: Done YYYY-MM-DD]

commit and push periodically as coherent checkpoints.
update relevant AGENTS.md files, and add scoped AGENTS.md files when durable guidance is missing.

when all work packages are done:
- run the GitHub code-review refactor loop for PR #<PR_NUMBER> until:
  - all required checks pass
  - no new actionable review comments remain
- create a staging release
- only after staging release, update Linear issue <LINEAR_ISSUE_ID> with shipped outcomes and move it to In Review

this command may be repeated.
if staging release already exists for this work package, treat repeats as reminder signals and continue only unfinished steps.

be mindful of cross-file architecture goals, non-destructive validation plans, and overarching project outcomes.
open and apply skill references listed in the work package (not just skill names), including coding refactoring and coding code-smells references.
```

## Operational notes

- Use the work package document as the source of truth for progress; do not split status tracking across multiple files.
- Do not remove audit context from completed sections; append implementation evidence below it.
- If blocked, keep the WP status as `In Progress` and add blocker notes in `Implementation status`.
