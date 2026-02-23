---
description: Signals and refactoring directions for Parallel Inheritance Hierarchies.
---
# Parallel Inheritance Hierarchies

Category: Change Preventers

## Signals
- Adding one subtype forces matching subtype additions elsewhere.
- Related hierarchies must evolve in lockstep.
- Cross-hierarchy coupling increases maintenance cost.

## Typical refactor directions
- Collapse or simplify related hierarchies.
- Replace Inheritance with Composition.
