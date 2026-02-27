---

description: Signals and refactoring directions for Incomplete Library Class.
metadata:
  id: coding.ref.code-smells.smells.incomplete-library-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - incomplete library class
    - references
    - smells
    - references code-smells smells incomplete-library-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Incomplete Library Class

Category: Couplers

## Signals
- Repeated library wrappers appear across the codebase.
- Missing library capabilities require scattered workarounds.
- Usage inconsistencies increase maintenance risk.

## Typical refactor directions
- Introduce a focused extension/adapter layer.
- Centralize library workarounds in one module.
