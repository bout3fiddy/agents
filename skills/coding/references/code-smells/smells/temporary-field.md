---

description: Signals and refactoring directions for Temporary Field.
metadata:
  id: coding.ref.code-smells.smells.temporary-field
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - references
    - smells
    - temporary field
    - references code-smells smells temporary-field
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Temporary Field

Category: Object-Orientation Abusers

## Signals
- Some fields are only meaningful in rare execution paths.
- Many methods must guard against null or unset state.
- Class invariants are unclear outside narrow contexts.

## Typical refactor directions
- Extract Class.
- Introduce Null Object.
