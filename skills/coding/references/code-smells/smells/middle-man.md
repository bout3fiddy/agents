---
description: Signals and refactoring directions for Middle Man.
---
# Middle Man

Category: Couplers

## Signals
- A class mostly forwards calls to another class.
- Wrapper adds little domain value.
- Indirection increases call depth without benefit.

## Typical refactor directions
- Remove Middle Man.
- Inline simple delegation.
