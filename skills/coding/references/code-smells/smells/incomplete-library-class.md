---
description: Signals and refactoring directions for Incomplete Library Class.
---
# Incomplete Library Class

Category: Couplers

## Signals
- Repeated library wrappers appear across the codebase.
- Missing library capabilities require scattered workarounds.
- Usage inconsistencies increase maintenance risk.

## Typical refactor directions
- Introduce a focused extension/adapter layer.
- Centralize library workarounds in one module.
