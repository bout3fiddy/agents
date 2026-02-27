---

description: Signals and refactoring directions for Duplicate Code.
metadata:
  id: coding.ref.code-smells.smells.duplicate-code
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - duplicate code
    - references
    - smells
    - references code-smells smells duplicate-code
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

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
