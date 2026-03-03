---

description: Operational code-smell index for coding work. Use this as the smell entrypoint for detection, classification, and targeted mitigation references.
metadata:
  id: coding.ref.code-smells.index
  version: "1"
  task_types:
    - coding
    - code-smell
    - refactor
    - code-review
  trigger_phrases:
    - code smell
    - code smells
    - maintainability
    - quality review
    - refactor risk
    - smell diagnostics
  priority: 70
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Code Smells (Operational Index)

Use this file as the first stop for smell-focused coding work.

## Workflow
1. Always read `detection-signals.md` first for broad pattern matching across all smells.
2. Always open every file listed under "Always-check policy" below — these are mandatory
   regardless of what detection signals suggest. The cheat sheet summaries are not sufficient
   substitutes for always-check files.
3. Classify likely smell families from the request, code evidence, and detection signals.
4. Open matching smell files from the catalog below for detailed refactor guidance.
5. For new-code tasks, default to broader coverage — check at least the always-check
   policy files plus any category where the task touches related structures.
6. Report findings with canonical smell labels, severity, concrete evidence, and mitigation options.
7. Do not auto-refactor unless explicitly requested.

## Always-check policy
- `skills/coding/references/code-smells/smells/ai-code-smell.md` (fallback-first/compatibility-branch guardrail)

## Detection cheat sheet
- `skills/coding/references/code-smells/detection-signals.md` (condensed heuristics for all 24 smells)

## Full catalog

### Bloaters
- `skills/coding/references/code-smells/smells/long-method.md`
- `skills/coding/references/code-smells/smells/large-class.md`
- `skills/coding/references/code-smells/smells/primitive-obsession.md`
- `skills/coding/references/code-smells/smells/long-parameter-list.md`
- `skills/coding/references/code-smells/smells/data-clumps.md`

### Object-Orientation Abusers
- `skills/coding/references/code-smells/smells/switch-statements.md`
- `skills/coding/references/code-smells/smells/temporary-field.md`
- `skills/coding/references/code-smells/smells/refused-bequest.md`
- `skills/coding/references/code-smells/smells/alternative-classes-with-different-interfaces.md`

### Change Preventers
- `skills/coding/references/code-smells/smells/divergent-change.md`
- `skills/coding/references/code-smells/smells/shotgun-surgery.md`
- `skills/coding/references/code-smells/smells/parallel-inheritance-hierarchies.md`
- `skills/coding/references/code-smells/smells/ai-code-smell.md`

### Dispensables
- `skills/coding/references/code-smells/smells/comments.md`
- `skills/coding/references/code-smells/smells/duplicate-code.md`
- `skills/coding/references/code-smells/smells/lazy-class.md`
- `skills/coding/references/code-smells/smells/data-class.md`
- `skills/coding/references/code-smells/smells/dead-code.md`
- `skills/coding/references/code-smells/smells/speculative-generality.md`

### Couplers
- `skills/coding/references/code-smells/smells/feature-envy.md`
- `skills/coding/references/code-smells/smells/inappropriate-intimacy.md`
- `skills/coding/references/code-smells/smells/message-chains.md`
- `skills/coding/references/code-smells/smells/middle-man.md`
- `skills/coding/references/code-smells/smells/incomplete-library-class.md`

## Deep catalog
- `skills/coding/references/code-smells/smells/index.md`
