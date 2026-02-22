---
description: Signals and refactoring directions for Dead Code.
---
# Dead Code

Category: Dispensables

## Signals
- Unreachable branches or unused functions remain in the codebase.
- Old flags and paths are never executed.
- Dead paths create noise and mislead reviewers.

## Typical refactor directions
- Remove unused code with tests and dependency checks.
- Delete obsolete flags and stale pathways.
