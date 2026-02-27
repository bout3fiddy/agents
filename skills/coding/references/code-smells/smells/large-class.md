---

description: Signals and refactoring directions for Large Class.
metadata:
  id: coding.ref.code-smells.smells.large-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - large class
    - references
    - smells
    - references code-smells smells large-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Large Class

Category: Bloaters

## Signals
- A class owns too many fields or methods.
- Responsibilities are unrelated but co-located.
- Frequent changes touch unrelated class regions.

## Typical refactor directions
- Extract Class.
- Extract Interface.
- Move Method and Move Field.
