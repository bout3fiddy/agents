---

description: Signals and refactoring directions for Feature Envy.
metadata:
  id: coding.ref.code-smells.smells.feature-envy
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - feature envy
    - references
    - smells
    - references code-smells smells feature-envy
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Feature Envy

Category: Couplers

## Signals
- A method uses another object's data more than its own.
- Frequent getter chains target a foreign type.
- Behavior sits far from the data it depends on.

## Typical refactor directions
- Move Method.
- Extract Method near the owning data.
