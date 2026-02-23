---
description: Signals and refactoring directions for Shotgun Surgery.
---
# Shotgun Surgery

Category: Change Preventers

## Signals
- A single logical change requires edits across many files.
- Small related tweaks are scattered and hard to track.
- Regression risk rises from broad change surfaces.

## Typical refactor directions
- Move Method or Move Field.
- Inline Class.
- Consolidate ownership of related behavior.
