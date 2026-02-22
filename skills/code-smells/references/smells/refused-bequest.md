---
description: Signals and refactoring directions for Refused Bequest.
---
# Refused Bequest

Category: Object-Orientation Abusers

## Signals
- Subclasses inherit members they do not use.
- Overrides exist mainly to disable base behavior.
- Inheritance relationship does not model reality.

## Typical refactor directions
- Replace Inheritance with Delegation.
- Push Down Method or Push Down Field.
