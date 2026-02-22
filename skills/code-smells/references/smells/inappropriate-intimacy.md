---
description: Signals and refactoring directions for Inappropriate Intimacy.
---
# Inappropriate Intimacy

Category: Couplers

## Signals
- Classes rely on each other's internals.
- Private details leak across boundaries.
- Tight coupling blocks independent evolution.

## Typical refactor directions
- Hide Delegate.
- Move Method or Move Field.
- Tighten ownership boundaries.
