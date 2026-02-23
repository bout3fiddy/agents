---
description: Signals and refactoring directions for Large Class.
---
# Large Class

Category: Bloaters

## Signals
- A class owns too many fields or methods.
- Responsibilities are unrelated but co-located.
- Frequent changes touch unrelated class regions.

## Typical refactor directions
- Extract Class.
- Extract Interface.
- Move Method and Move Field.
