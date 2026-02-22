---
description: Signals and refactoring directions for Message Chains.
---
# Message Chains

Category: Couplers

## Signals
- Call sites contain long chained access (`a.b().c().d()`).
- Clients traverse object graphs directly.
- Structural changes ripple across consumers.

## Typical refactor directions
- Hide Delegate.
- Move Method to reduce traversal leakage.
