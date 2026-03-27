# Work Package Standard

Load this workflow when creating or revising versioned work package docs. Use
`workpackage-execution.md` as the companion procedure when the request is to
implement from an existing package.

The canonical pattern is the planning-first, multi-file structure used in
`docs/workpackages/absurd-cutover/`: one package index plus one markdown file
per `WP-XX`.

Concrete starting points live here:

- `references/templates/mock-overview.md`
- `references/templates/mock-wp.md`

## Canonical folder shape

Work packages live in `docs/workpackages/<slug>/`.

- Use a short, stable, hyphenated slug that names the cutover, refactor,
  migration, or feature set.
- `README.md` is required. It is the shared entrypoint and package index.
- Each work package item lives in its own file:
  `wp-XX-<short-slug>.md`.
- Use zero-padded numbering (`WP-01`, `WP-02`, ...), and keep the file name,
  title, and package list entry aligned.
- Treat these docs as versioned planning artifacts by default, not scratch
  notes.

## README requirements

`README.md` should mirror the example structure and include:

1. `# <Initiative Name> Workpackages`
2. `## Overview`
3. `## Critical Path`
4. `## Packages`
5. `## Shared Architectural Rules`
6. `## Existing Runtime Anchors` or equivalent source anchors when the plan is
   grounded in a live system

Recommended skeleton:

```markdown
# <Initiative Name> Workpackages

## Overview

This folder captures the planning-only workpackages for moving <system> to:

- <move 1>
- <move 2>

## Critical Path

`WP-01 -> WP-02 -> (WP-03 / WP-04) -> WP-05`

## Packages

- [WP-01 <Title>](./wp-01-<slug>.md)
- [WP-02 <Title>](./wp-02-<slug>.md)

## Shared Architectural Rules

- <cross-cutting invariant 1>
- <cross-cutting invariant 2>

## Existing Runtime Anchors

- Trigger path:
  - `path/to/current/entrypoint.py`
- Current orchestration:
  - `path/to/current/orchestrator.py`
```

Notes:

- `## Critical Path` should show the intended dependency order compactly.
- `## Packages` should be a flat linked list of every `WP-XX`.
- `## Shared Architectural Rules` should capture the invariants every package
  must preserve.
- Use `## Existing Runtime Anchors` when current code paths, services, queues,
  or tables need to be named up front.

## Per-package file requirements

Each `wp-XX-*.md` file is one self-contained plan unit and should use this
shape:

```markdown
# WP-XX <Title>

## Metadata

- Created: YYYY-MM-DD
- Scope: <single-sentence scope>
- Input sources:
  - `path/to/source_a`
  - `path/to/source_b`
- Dependencies:
  - none
- Reference baseline:
  - <current code path or doc>

## Background

<current-state explanation>

## Overarching Goals

- <goal 1>
- <goal 2>

## Non-goals

- <explicit non-goal 1>
- <explicit non-goal 2>

### WP-XX <Sentence case title> [Status: Todo]

Issue:
<what is broken, missing, or ambiguous today>

Needs:
- <requirement 1>
- <requirement 2>

How:
1. <step 1>
2. <step 2>

Why this approach:
<why this decomposition is the right one>

Desired outcome:
<what is true after this package lands>

Non-destructive tests:
- `<command 1>`
- `<command 2>`

Files by type:
- New targets:
  - `path/to/new_file`
- Existing targets to refactor:
  - `path/to/existing_file`
- Validation targets:
  - `path/to/test_file`

## Exact Patch Checklist

- [ ] <concrete code or schema change>
- [ ] <concrete invariant or publication change>
- [ ] <concrete validation or migration step>

## Completion Checklist

- [ ] Implementation matches the described approach
- [ ] Non-destructive tests pass
- [ ] <package-specific acceptance gate>
- [ ] <package-specific acceptance gate>

## Implementation Status (YYYY-MM-DD)

Planning only. No code changes yet.

## Why This Works

<causal explanation>

## Proof / Validation

- Planned: <validation scenario>
- Planned: <validation scenario>

## How To Test

1. <reproducible verification step>
2. <reproducible verification step>
```

## Section rules

### Metadata

Required metadata fields:

- `Created`
- `Scope`
- `Input sources`
- `Dependencies`
- `Reference baseline`

Use `Dependencies: - none` only when the package is truly independent. Otherwise
list upstream `WP-XX` items explicitly.

### Background / goals / non-goals

- `## Background` explains the current state and why the package exists.
- `## Overarching Goals` captures the intended outcomes at a higher level than
  the patch checklist.
- `## Non-goals` makes boundaries explicit. If another package owns a concern,
  name it directly.

### Primary package section

The `### WP-XX ... [Status: Todo]` block is the execution contract for that
file. It must include:

- `Issue`
- `Needs`
- `How`
- `Why this approach`
- `Desired outcome`
- `Non-destructive tests`
- `Files by type`

Keep `Needs` and `How` concrete enough that another engineer could implement the
package without reconstructing the plan from scratch.

### Exact Patch Checklist

This checklist is required and must be concrete. It is where the plan stops
being thematic and starts being implementation-shaped.

- Prefer exact functions, tables, services, and files.
- Encode cutover rules, migration boundaries, replay/idempotency expectations,
  and invariants here.
- If a package contains several meaningful substeps, the checklist should make
  those boundaries obvious.

### Completion Checklist

This checklist is also required and should combine:

- baseline execution gates
- package-specific acceptance criteria

At minimum include:

- `Implementation matches the described approach`
- `Non-destructive tests pass`

Add package-specific gates for the real success conditions. Examples:

- `Provider-only revision bump does not force full-stage rerun`
- `Migrations are additive only`
- `Manual edit guard works`

### Accountability sections

Every package file must end with:

- `## Implementation Status (YYYY-MM-DD)`
- `## Why This Works`
- `## Proof / Validation`
- `## How To Test`

For planning-only docs, it is correct to start with `Planning only. No code
changes yet.` in `Implementation Status`.

When implementation happens, replace the placeholder text with the actual change
set, proof, and reproducible verification steps.

## Status rules

- Start new packages at `[Status: Todo]`.
- Use `[Status: In Progress]` only when execution has begun and the package is
  partially complete.
- Use `[Status: Done]` only when every item in `## Completion Checklist` is
  checked.

Never mark a package done while any checklist box is still unchecked.

## Lifecycle

- Keep a linked Linear issue refined and traceable when Linear is part of the
  workflow.
- Use `README.md` plus the per-file `Dependencies` metadata to make sequencing
  obvious.
- Treat repeated requests as continuation signals: resume from the first
  non-done runnable `WP-XX`.
- Default to hard cutovers. Do not add fallback branches or temporary shims
  unless they are explicitly approved and come with an owner, removal date, and
  tracking issue.

## Version-control notes

- When the task is to author or revise the work package plan itself, commit the
  docs as normal versioned source.
- When the task is to execute from an existing plan, follow
  `workpackage-execution.md` for how to keep the docs current and whether those
  updates should ship.
- Never use `git add .`, `git add -A`, or `git add -f`; stage exact paths and
  verify the staged set before every commit.
