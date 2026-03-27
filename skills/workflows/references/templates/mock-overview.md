# Example Platform Cutover Workpackages

## Overview

This folder captures the planning-only workpackages for moving Example Platform
from a polling worker model to an event-driven runtime with durable artifacts
and replay-safe publication.

The plan assumes:

- the new runtime becomes the only live orchestrator after cutover
- durable artifacts become the semantic source of truth
- current application tables remain mutable projections

## Critical Path

`WP-01 -> WP-02 -> (WP-03 / WP-04) -> WP-05`

## Packages

- [WP-01 Runtime contract and target model](./wp-01-runtime-contract-and-target-model.md)
- [WP-02 Additive schema and repository layer](./wp-02-additive-schema-and-repository-layer.md)
- [WP-03 Intake artifactization](./wp-03-intake-artifactization.md)
- [WP-04 Processing artifactization](./wp-04-processing-artifactization.md)
- [WP-05 Runtime cutover and queue retirement](./wp-05-runtime-cutover-and-queue-retirement.md)

## Shared Architectural Rules

- The new runtime becomes the only live orchestrator after cutover.
- Successful artifacts are immutable.
- Retry and crash recovery resume the same lineage.
- Semantic changes create a new lineage.
- Current app tables remain projections, not semantic truth.
- Publication must be replay-safe and idempotent.

## Existing Runtime Anchors

- Trigger path:
  - `src/example_platform/intake/trigger.py`
  - `src/example_platform/api/enqueue.py`
- Current queue runtime:
  - `src/example_platform/runtime/queue_consumer.py`
  - `src/example_platform/runtime/worker.py`
- Current orchestration:
  - `src/example_platform/runtime/orchestrator.py`
  - `src/example_platform/runtime/services/pipeline_service.py`
- Existing persistence:
  - `platform/database/postgres/migrations/20260301090000_add_jobs.sql`
  - `src/example_platform/runtime/repositories/job_repository.py`
