---
description: Signals and refactoring directions for Long Method.
---
# Long Method

Category: Bloaters

## Signals
- Methods are very long and blend multiple responsibilities.
- Control flow is deeply nested or hard to follow.
- Large inline branches hide intent.

## Typical refactor directions
- Extract Method.
- Replace Temp with Query.
- Decompose Conditional.
