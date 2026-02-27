---

name: spec-driven-iterative-builder
description: Spec-first iterative delivery workflow for multi-step implementation, continuation prompts, and work-package-driven execution. Keep `docs/specs/*` as living source of truth and synchronize with work-package status when present.
metadata:
  id: planning.ref.spec-driven-iterative-builder
  version: "1"
  task_types:
    - plan
    - workpackage
  trigger_phrases:
    - references
    - spec driven iterative builder
    - references spec-driven-iterative-builder
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - workpackage_path_detected
    - continuation_directive_detected
  route_exclude: false

---



# Spec-Driven Iterative Builder

## Operating rules
- If must-have requirements are ambiguous, run `skills/planning/references/ask-questions-if-underspecified.md` first, then continue here.
- Create or update a spec in `docs/specs/<slug>.md` for each consideration before implementation.
- Keep the spec as the source of truth for progress, decisions, experiments, and next steps.
- When work packages exist in `docs/workpackages/...` or `docs/review/workpackages_*`, keep the spec and work-package status synchronized.
- Work incrementally: design, implement, validate, document, then move to the next item.
- Continue execution without unnecessary check-ins while still honoring explicit approval gates in repository/workpackage directives.

## Spec template (minimum sections)
- Title / Scope
- Goals and Non-goals
- Assumptions and Constraints
- Research Summary (with sources if used)
- Architecture and Approach
- Implementation Plan (ordered steps)
- Work-package mapping (optional: `WP-*` item -> spec step -> validation proof)
- Experiments / Trials (what was tried and outcomes)
- Validation (lint/tests run and results)
- Open Questions / Risks
- Next Steps

## Workflow (standard mode; repeat per consideration)
1) Identify the consideration and create or update its spec in `docs/specs/`.
2) Gather required context from the codebase; summarize relevant findings in the spec.
3) Research when needed; capture sources and key takeaways in the spec.
4) Propose architecture and plan in the spec; then implement incrementally.
5) Try approaches in code; record outcomes and tradeoffs in the spec.
6) Run linting/pre-commit and relevant tests; record results in the spec.
7) If a path fails, pivot: research alternatives, try again, and document.
8) Mark the consideration complete in the spec and move to the next one.

## Work-package mode (when prompt points to `docs/workpackages/...` or `docs/review/workpackages_*`)
1) Open `overview.md` first and find the first `WP-*` item that is not done (unless the prompt specifies another item).
2) Create or update a companion spec in `docs/specs/<slug>.md` and add a mapping table from each active `WP-*` item to planned implementation/validation.
3) Execute one `WP-*` item at a time; keep status, rationale, and validation notes synchronized between the spec and the work-package files.
4) For completed `WP-*` items, ensure the work package records implementation status date, why this works, proof/validation, and how to test.
5) If blocked, document blocker + owner + required next state in both the spec and `overview.md`, then continue with the next viable item.
6) Treat repeated "start implementing work package: ..." and "start implementing fixes per work package: ..." prompts as continuation: resume from the first non-done item by default.

## When things don’t work
- Use web search to find fixes or alternative approaches.
- Update the spec with what failed, why, and the new plan.
- Keep going until the consideration is resolved or clearly blocked.

## Output expectations
- Provide a short completion note with spec path and, when in work-package mode, the updated work-package path/item IDs.
