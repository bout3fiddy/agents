---

description: Standard structure for refactoring work packages, including status tracking, skill-reference invocation, rationale traceability, and implementation accountability proof.
metadata:
  id: coding.ref.refactoring.workpackage-template
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - refactoring
    - references
    - workpackage template
    - references refactoring workpackage-template
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: true

---


# Refactoring Work Package Template

Use this template for all refactoring work packages. The canonical location is:

`docs/review/workpackages_<name>_<date>/`

Use a date suffix in `DDMMYYYY` format to match current conventions. Store one or more markdown files in that folder (for example: `overview.md`, `wp-01.md`, `wp-02.md`).

## Required folder layout

- `overview.md` (required): canonical progress summary and execution entry point.
- `wp-*.md` (optional but recommended): detailed per-item execution/audit notes.

## Required top-of-file directive

Place this at the top of the primary work package entry file (directly after the title). If execution prompts target the folder root, this entry file is the first file the execution agent should open.

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

## Overview summary requirements (`overview.md`)

`overview.md` must include a compact rollup table (or equivalent list) for all `WP-*` items with:

- `WP ID`
- `Status` (`Todo` / `In Progress YYYY-MM-DD` / `Done YYYY-MM-DD`)
- `Last updated`
- `Proof / validation pointer` (file + section or command summary location)
- `Next action`

Execution agents should use this rollup first to determine what to do next before opening additional `wp-*.md` files.

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
  - `skills/coding/references/code-smells/smells/ai-code-smell.md`

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
  - hard-cutover status (`Default hard cutover` or `Exception approved`) citing `skills/coding/references/code-smells/smells/ai-code-smell.md`
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

After updating the detailed `WP-XX` content, update `overview.md` in the same change so summary state stays authoritative.

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
