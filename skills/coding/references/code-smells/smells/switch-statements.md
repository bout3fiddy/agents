---

description: Signals and refactoring directions for Switch Statements.
metadata:
  id: coding.ref.code-smells.smells.switch-statements
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - references
    - smells
    - switch statements
    - references code-smells smells switch-statements
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Switch Statements

Category: Object-Orientation Abusers

## Signals
- Similar switch or if/else type dispatch appears across files.
- Branches grow when new types are added.
- Behavior is selected by codes instead of object behavior.

## Typical refactor directions
- Replace Conditional with Polymorphism.
- Replace Type Code with Subclasses, State, or Strategy.
