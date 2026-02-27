---

description: Signals and refactoring directions for Inappropriate Intimacy.
metadata:
  id: coding.ref.code-smells.smells.inappropriate-intimacy
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - inappropriate intimacy
    - references
    - smells
    - references code-smells smells inappropriate-intimacy
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Inappropriate Intimacy

Category: Couplers

## Signals
- Classes rely on each other's internals.
- Private details leak across boundaries.
- Tight coupling blocks independent evolution.

## Typical refactor directions
- Hide Delegate.
- Move Method or Move Field.
- Tighten ownership boundaries.
