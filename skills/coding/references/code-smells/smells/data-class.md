---

description: Signals and refactoring directions for Data Class.
metadata:
  id: coding.ref.code-smells.smells.data-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - data class
    - references
    - smells
    - references code-smells smells data-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Data Class

Category: Dispensables

## Signals
- Class mostly contains fields with trivial getters/setters.
- Behavior that should live with data appears elsewhere.
- Invariants are enforced outside the owning type.

## Typical refactor directions
- Move behavior to the data owner.
- Encapsulate field access and enforce invariants internally.
