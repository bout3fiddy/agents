---
description: Signals and refactoring directions for Divergent Change.
---
# Divergent Change

Category: Change Preventers

## Signals
- One class changes for many unrelated reasons.
- Release work repeatedly touches the same class for different concerns.
- Responsibility boundaries are blurred.

## Typical refactor directions
- Extract Class.
- Split responsibilities by change axis.
