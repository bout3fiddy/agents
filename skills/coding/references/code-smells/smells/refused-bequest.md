---

description: Signals and refactoring directions for Refused Bequest.
metadata:
  id: coding.ref.code-smells.smells.refused-bequest
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - references
    - refused bequest
    - smells
    - references code-smells smells refused-bequest
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

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
