---
description: Signals and refactoring directions for Data Clumps.
---
# Data Clumps

Category: Bloaters

## Signals
- The same small field groups travel together repeatedly.
- Multiple APIs share identical argument bundles.
- Related data lacks a named abstraction.

## Typical refactor directions
- Extract Class.
- Introduce Parameter Object.
