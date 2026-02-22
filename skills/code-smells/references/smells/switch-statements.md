---
description: Signals and refactoring directions for Switch Statements.
---
# Switch Statements

Category: Object-Orientation Abusers

## Signals
- Similar switch or if/else type dispatch appears across files.
- Branches grow when new types are added.
- Behavior is selected by codes instead of object behavior.

## Typical refactor directions
- Replace Conditional with Polymorphism.
- Replace Type Code with Subclasses, State, or Strategy.
