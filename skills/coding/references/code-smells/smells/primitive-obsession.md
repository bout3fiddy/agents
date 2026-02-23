---
description: Signals and refactoring directions for Primitive Obsession.
---
# Primitive Obsession

Category: Bloaters

## Signals
- Domain concepts are represented with raw primitives.
- Validation/parsing rules are duplicated everywhere.
- Type codes drive behavior in many places.

## Typical refactor directions
- Replace Data Value with Object.
- Introduce Parameter Object.
- Replace Type Code with Subclasses, State, or Strategy.
