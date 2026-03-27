# WP-03 Intake Artifactization

## Metadata

- Created: 2026-03-27
- Scope: break the current intake stage into durable, reusable artifacts and
  route projection writes through a shared publication boundary
- Input sources:
  - `src/example_platform/runtime/intake.py`
  - `src/example_platform/runtime/services/source_loader.py`
  - `src/example_platform/runtime/services/normalizer.py`
  - `src/example_platform/runtime/repositories/intake_repository.py`
- Dependencies:
  - `WP-01`
  - `WP-02`
- Reference baseline:
  - current intake execution flow in `src/example_platform/runtime/intake.py`

## Background

The intake stage currently loads source data, normalizes it, derives a
processing payload, and writes current-state rows in one procedural run. That
keeps the stage simple, but it means retries and semantic changes rerun from
too early because the runtime has no durable intermediate boundaries.

## Overarching Goals

- Create meaningful artifact boundaries inside intake.
- Reuse unchanged intake work on reruns.
- Publish intake projections through one idempotent boundary.

## Non-goals

- Deep processing; that belongs to `WP-04`.
- Runtime cutover; that belongs to `WP-05`.
- Replacing current projection tables with historical truth tables.

### WP-03 Intake artifactization [Status: Todo]

Issue:
The current intake stage persists current-state projections, but it does not
persist reusable semantic artifacts that later planner decisions can reason
about.

Needs:
- step-level artifacts for source capture, normalization, and payload assembly
- dependency edges between those artifacts
- replay-safe intake publication into current tables

How:
1. Split intake into explicit step functions with stable identities.
2. Have each step create or reuse artifacts through the graph repository.
3. Publish the intake milestone through the shared publication service.

Why this approach:
Intake is the earliest place where durable reuse becomes valuable. If source
capture is unchanged, semantic changes in normalization or payload assembly
should reuse upstream work instead of rerunning the entire stage.

Desired outcome:
The planner can reuse unchanged intake artifacts and republish the current
intake view safely.

Non-destructive tests:
- `uv run pytest tests/runtime/test_intake_workflow.py`
- `uv run pytest tests/runtime/test_publication_service.py`
- `uv run pytest tests/runtime/test_source_loader.py`

Files by type:
- New workflow step targets:
  - `src/example_platform/runtime/workflow/intake_steps.py`
  - `src/example_platform/runtime/workflow/intake_publish.py`
- Existing targets to refactor:
  - `src/example_platform/runtime/intake.py`
  - `src/example_platform/runtime/services/source_loader.py`
  - `src/example_platform/runtime/services/normalizer.py`
  - `src/example_platform/runtime/repositories/intake_repository.py`
- Validation targets:
  - `tests/runtime/test_intake_workflow.py`
  - `tests/runtime/test_publication_service.py`
  - `tests/runtime/test_source_loader.py`

## Exact Patch Checklist

- [ ] Extract `capture_source_snapshot` from the current source loading path.
- [ ] Extract `normalize_source_payload` from the current normalization path.
- [ ] Extract `build_processing_payload` as the milestone root for intake.
- [ ] Write graph artifacts and dependency edges for each intake step.
- [ ] Route current intake projection writes through publication service.
- [ ] Ensure repeated publication with the same idempotency key is a no-op.

## Completion Checklist

- [ ] Implementation matches the described approach
- [ ] Non-destructive tests pass
- [ ] Unchanged rerun reuses intake artifacts
- [ ] Intake publication is replay-safe

## Implementation Status (2026-03-27)

Planning only. No code changes yet.

## Why This Works

The intake stage already has meaningful internal boundaries. Turning those into
first-class artifacts gives the planner a reliable reuse boundary without
changing the shape of downstream processing.

## Proof / Validation

- Planned: unchanged rerun reuses source snapshot and normalized payload
- Planned: normalization-only revision bump invalidates only the stale suffix
- Planned: duplicate publication does not double-write current projections

## How To Test

1. Run intake once for a representative source payload.
2. Run it again with the same target spec and confirm upstream artifacts are
   reused.
3. Change the normalization revision and confirm stale frontier starts at
   `normalize_source_payload`.
4. Replay the same publication and confirm current tables are unchanged.
