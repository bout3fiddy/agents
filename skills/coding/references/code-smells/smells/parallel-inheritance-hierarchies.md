---

description: Signals and refactoring directions for Parallel Inheritance Hierarchies.
metadata:
  id: coding.ref.code-smells.smells.parallel-inheritance-hierarchies
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - parallel inheritance hierarchies
    - references
    - smells
    - references code-smells smells parallel-inheritance-hierarchies
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Parallel Inheritance Hierarchies

Category: Change Preventers

## Signals
- Adding one subtype forces matching subtype additions elsewhere.
- Related hierarchies must evolve in lockstep.
- Cross-hierarchy coupling increases maintenance cost.

## Typical refactor directions
- Collapse or simplify related hierarchies.
- Replace Inheritance with Composition.
