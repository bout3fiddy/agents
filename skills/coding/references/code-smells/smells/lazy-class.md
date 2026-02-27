---

description: Signals and refactoring directions for Lazy Class.
metadata:
  id: coding.ref.code-smells.smells.lazy-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - lazy class
    - references
    - smells
    - references code-smells smells lazy-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Lazy Class

Category: Dispensables

## Signals
- A class adds little behavior beyond indirection.
- Type boundaries exist without meaningful responsibility.
- Maintenance overhead exceeds its value.

## Typical refactor directions
- Inline Class.
- Collapse Hierarchy.
