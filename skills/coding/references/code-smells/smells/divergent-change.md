---

description: Signals and refactoring directions for Divergent Change.
metadata:
  id: coding.ref.code-smells.smells.divergent-change
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - divergent change
    - references
    - smells
    - references code-smells smells divergent-change
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Divergent Change

Category: Change Preventers

## Signals
- One class changes for many unrelated reasons.
- Release work repeatedly touches the same class for different concerns.
- Responsibility boundaries are blurred.

## Typical refactor directions
- Extract Class.
- Split responsibilities by change axis.
