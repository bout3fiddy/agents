# Work Package Standard

Use this format for versioned, multi-part implementation plans that need durable
dependencies, acceptance gates, and handoff evidence. A short ordinary plan does
not need a work-package directory.

## Package layout

```text
docs/workpackages/<stable-slug>/
├── README.md
├── wp-01-<slug>.md
├── wp-02-<slug>.md
└── ...
```

- `README.md` is the package index and shared architectural context.
- Each `WP-XX` owns one coherent outcome and lives in one file.
- Use zero-padded identifiers and keep filenames, headings, links, and
  dependency metadata aligned.
- Preserve existing repository placement when it already has a work-package
  convention.

Use [mock-overview.md](../assets/mock-overview.md) and
[mock-wp.md](../assets/mock-wp.md) as optional structural examples, not content
to copy blindly.

## README requirements

Keep the overview compact and include:

1. `# <Initiative> Work Packages`
2. `## Overview` — current state, target state, and scope boundary.
3. `## Critical Path` — dependency order and opportunities for safe parallelism.
4. `## Packages` — a flat linked list of every WP and its status.
5. `## Shared Architectural Rules` — invariants every package must preserve.
6. `## Existing Runtime Anchors` when current entrypoints, schemas, queues,
   services, or validation commands materially constrain the plan.

Do not duplicate each WP's detailed steps in the overview.

## Work-package file requirements

Each package should contain:

```markdown
# WP-XX <Title>

## Metadata
- Created: YYYY-MM-DD
- Scope: <one outcome>
- Input sources: <files, issues, specs, or decisions>
- Dependencies: <WP identifiers or none>
- Reference baseline: <current behavior or evidence>

## Background
## Goals
## Non-goals

## Requirements
## Implementation Approach
## Files and Boundaries
## Validation

## Exact Patch Checklist
- [ ] <concrete source/schema/config change>
- [ ] <concrete invariant or migration change>
- [ ] <concrete validation or cleanup step>

## Completion Checklist
- [ ] Implementation satisfies the stated requirements
- [ ] Required validation passes
- [ ] Package-specific acceptance condition

## Implementation Status
## Proof / Validation
## How to Test
```

Adapt headings when the repository already has a stronger convention, while
preserving the same information.

## Quality rules

- Tie requirements to exact functions, schemas, services, or behavior where
  discoverable. Do not manufacture precision for code that has not been read.
- Separate goals from implementation mechanics and name explicit non-goals.
- Record migration, compatibility, replay, idempotency, ordering, and rollback
  boundaries when they are part of the contract.
- Make validation reproducible: name commands, fixtures, expected states, or
  observable outputs.
- Keep checklist items independently verifiable. A checklist that merely says
  "implement the feature" is not an execution plan.
- Reference existing documentation instead of copying volatile defaults into
  every package.

## Status and version control

- New packages start `Todo`; use `In Progress` only while execution is active;
  mark `Done` only after every completion item is evidenced.
- Update package status and proof during execution only when the package is an
  intended deliverable or repository policy requires it.
- Planning documents ship when authoring or revising the plan is the requested
  deliverable. Execution-status churn remains non-shipping unless explicitly
  required.
- Prefer direct cutovers. Document compatibility paths only when a current
  consumer requires them, including their owner and removal condition.
