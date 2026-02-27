---

description: Signals and refactoring directions for Shotgun Surgery.
metadata:
  id: coding.ref.code-smells.smells.shotgun-surgery
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - references
    - shotgun surgery
    - smells
    - references code-smells smells shotgun-surgery
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Shotgun Surgery

Category: Change Preventers

## Signals
- A single logical change requires edits across many files.
- Small related tweaks are scattered and hard to track.
- Regression risk rises from broad change surfaces.

## Typical refactor directions
- Move Method or Move Field.
- Inline Class.
- Consolidate ownership of related behavior.
