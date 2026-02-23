---
description: Standard structure for refactoring work packages, including status tracking, skill-reference invocation, rationale traceability, and implementation accountability proof.
---

# Refactoring Work Package Template

Use this template for all refactoring work packages. The canonical location is:

`docs/review/workpackage_<name>_<date>.md`

Use a date suffix in `DDMMYYYY` format to match current conventions.

## Required top-of-file directive

Place this at the top of every work package (directly after the title):

`## Execution Directive (Standard)`

Copy from:

`skills/coding/references/refactoring/workpackage-execution-directive.md`

## Required document structure

Use this minimum structure:

1. Title
2. `Execution Directive (Standard)` block
3. Metadata
4. Background
5. Overarching goals
6. Non-goals
7. Work package items (`WP-01`, `WP-02`, ...)

## Metadata requirements

Include at minimum:

- Created date
- Scope
- Input sources used for audit
- Constraints, including non-destructive migration requirement
- `Skill references to invoke (global)` with concrete files to open first (must include at minimum):
  - `skills/coding/SKILL.md`
  - `skills/coding/references/refactoring/workpackage-execution-directive.md`
  - `skills/coding/references/code-smells/smells/index.md`

## Work package item template

Use this exact heading pattern:

`### WP-XX <Short title> [Status: Todo]`

Each `WP-XX` section must include:

- Issue
- Needs
- How
- Why this approach
- Recommendation rationale:
  - coding rule IDs from `skills/coding/SKILL.md` that justify the recommendation
  - smell mitigation targets from `skills/coding/references/code-smells/smells/*.md` (or explicit `No canonical smell`)
  - reference file paths used for the recommendation
- Desired outcome
- `Skill references to invoke` (concrete file paths; include coding + code-smells references relevant to this item)
- Non-destructive tests
- Files by type (when useful for traceability)

When implementation starts, update the title status:

`[Status: In Progress YYYY-MM-DD]`

When implementation is complete and validated:

`[Status: Done YYYY-MM-DD]`

## Accountability sections (required after implementation)

For each completed `WP-XX`, append all of:

- `Implementation status (YYYY-MM-DD)`:
  - Exactly what changed and where.
- `Why this works`:
  - Causal explanation linking the change to the targeted issue.
- `Proof / validation`:
  - Exact commands run and key outcomes (pass counts, CI result, runtime smoke result).
- `How to test`:
  - Reproducible manual and/or automated verification steps.

If implementation changes or narrows the original recommendation, update `Recommendation rationale` so traceability remains accurate.

## Non-destructive evidence expectations

Evidence should show:

- Behavior parity or intentional compatible deltas
- Focused tests for changed areas
- Typecheck/lint/build or equivalent quality gates
- Runtime validation (for web apps, include local host smoke checks and console-error checks)

## Resume semantics

Repeated execution prompts are expected. The execution agent should:

1. Read status lines across all `WP-XX`.
2. Continue from the first non-done item.
3. Avoid redoing done items unless regressions are detected.
4. If staging release is already complete, report final state and stop.
