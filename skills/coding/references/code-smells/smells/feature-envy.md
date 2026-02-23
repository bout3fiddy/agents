---
description: Signals and refactoring directions for Feature Envy.
---
# Feature Envy

Category: Couplers

## Signals
- A method uses another object's data more than its own.
- Frequent getter chains target a foreign type.
- Behavior sits far from the data it depends on.

## Typical refactor directions
- Move Method.
- Extract Method near the owning data.
