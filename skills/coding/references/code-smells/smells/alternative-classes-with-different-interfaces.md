---
description: Signals and refactoring directions for Alternative Classes with Different Interfaces.
---
# Alternative Classes with Different Interfaces

Category: Object-Orientation Abusers

## Signals
- Classes provide similar capabilities with incompatible APIs.
- Callers need adapter-like glue at many call sites.
- Teams duplicate logic per implementation due to naming mismatch.

## Typical refactor directions
- Rename Method.
- Move Method.
- Introduce Adapter.
