---
description: Signals and refactoring directions for Data Class.
---
# Data Class

Category: Dispensables

## Signals
- Class mostly contains fields with trivial getters/setters.
- Behavior that should live with data appears elsewhere.
- Invariants are enforced outside the owning type.

## Typical refactor directions
- Move behavior to the data owner.
- Encapsulate field access and enforce invariants internally.
