---

description: Signals and refactoring directions for Long Method.
metadata:
  id: coding.ref.code-smells.smells.long-method
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - long method
    - references
    - smells
    - references code-smells smells long-method
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Long Method

Category: Bloaters

## Signals
- Methods are very long and blend multiple responsibilities.
- Control flow is deeply nested or hard to follow.
- Large inline branches hide intent.

## Typical refactor directions
- Extract Method.
- Replace Temp with Query.
- Decompose Conditional.
