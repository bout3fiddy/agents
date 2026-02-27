---

description: Signals and refactoring directions for Comments.
metadata:
  id: coding.ref.code-smells.smells.comments
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - comments
    - references
    - smells
    - references code-smells smells comments
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Comments

Category: Dispensables

## Signals
- Comments explain confusing code instead of intent.
- Stale comments disagree with actual behavior.
- Commented-out code accumulates as dead history.

## Typical refactor directions
- Rename symbols and extract expressive methods.
- Remove dead/commented-out code.
- Keep comments for intent and constraints, not patching unclear code.
