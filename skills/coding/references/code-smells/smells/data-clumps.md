---

description: Signals and refactoring directions for Data Clumps.
metadata:
  id: coding.ref.code-smells.smells.data-clumps
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - data clumps
    - references
    - smells
    - references code-smells smells data-clumps
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Data Clumps

Category: Bloaters

## Signals
- The same small field groups travel together repeatedly.
- Multiple APIs share identical argument bundles.
- Related data lacks a named abstraction.

## Typical refactor directions
- Extract Class.
- Introduce Parameter Object.
