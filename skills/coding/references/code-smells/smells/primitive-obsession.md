---

description: Signals and refactoring directions for Primitive Obsession.
metadata:
  id: coding.ref.code-smells.smells.primitive-obsession
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - primitive obsession
    - references
    - smells
    - references code-smells smells primitive-obsession
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Primitive Obsession

Category: Bloaters

## Signals
- Domain concepts are represented with raw primitives.
- Validation/parsing rules are duplicated everywhere.
- Type codes drive behavior in many places.

## Typical refactor directions
- Replace Data Value with Object.
- Introduce Parameter Object.
- Replace Type Code with Subclasses, State, or Strategy.
