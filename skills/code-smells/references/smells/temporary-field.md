---
description: Signals and refactoring directions for Temporary Field.
---
# Temporary Field

Category: Object-Orientation Abusers

## Signals
- Some fields are only meaningful in rare execution paths.
- Many methods must guard against null or unset state.
- Class invariants are unclear outside narrow contexts.

## Typical refactor directions
- Extract Class.
- Introduce Null Object.
