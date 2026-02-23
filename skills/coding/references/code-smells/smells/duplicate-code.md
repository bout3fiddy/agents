---
description: Signals and refactoring directions for Duplicate Code.
---
# Duplicate Code

Category: Dispensables

## Signals
- Similar logic is copied across modules or services.
- Bug fixes must be repeated in multiple places.
- Slightly diverged copies hide shared intent.

## Typical refactor directions
- Extract Method.
- Pull Up Method.
- Consolidate shared utilities or core primitives.
