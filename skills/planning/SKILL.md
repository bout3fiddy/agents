---

name: planning
description: "Planning workflows for clarifying ambiguous build requests, running spec/work-package delivery, and managing Linear lifecycle transitions."
metadata:
  id: planning.core
  version: "1"
  task_types:
    - planning
    - plan
    - spec
    - linear
    - workpackage
    - clarify
  trigger_phrases:
    - planning
    - spec
    - work package
    - linear issue
    - scope ambiguity
    - requirements clarification
    - project lifecycle
    - workpackage
    - Linear
  priority: 85
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - linear_issue_context_detected
    - workpackage_path_detected
    - planning_request_detected
  operation_contracts:
    workpackage_execution:
      required_steps:
        - read_overview
        - select_target_wp
        - honor_local_directives
        - sync_status_and_evidence
      required_output_fields:
        - target_wp
        - status_update
        - proof_pointer
        - next_action
      forbidden_actions:
        - skip_overview
        - ignore_approval_gate
    linear_transition:
      required_steps:
        - read_issue
        - map_lifecycle_state
        - apply_transition
        - verify_write
        - post_transition_comment
      required_output_fields:
        - state_change
        - work_summary
        - validation
        - follow_ups
        - owner_next_step
      forbidden_actions:
        - write_without_readback
        - update_without_transition_reason
    clarification_gate:
      required_steps:
        - ask_minimum_questions
        - confirm_assumptions
        - restate_requirements
      required_output_fields:
        - open_questions_or_assumptions
        - agreed_scope
        - success_criteria
      forbidden_actions:
        - directional_implementation_without_constraints

---

# Planning (Clarify + Spec + Track)

Use this skill when work is underspecified, needs a spec/work-package-first plan, or should be captured/tracked in Linear.

## Scope & routing
- Use for planning/spec/clarification requests, work-package orchestration, or when the user explicitly asks for a plan.
- If the primary task is creating/updating a skill, prefer skill-creator; use planning only for a plan-only response.
- If the request shifts to implementation/build work, hand off to `coding` after clarifying scope and locking assumptions.
- When opening references, use full repo paths like `skills/planning/references/...` (not `references/...`). If a reference read fails, retry once with the full path.
- If a trigger clearly matches, open the referenced file before drafting the plan/spec. If you need 1-2 clarifying questions first, ask them before opening the ref.
- If a word/length limit is given, keep it short and minimize extra reads.
- Treat all Linear status flow requests as planning work: load `skills/planning/references/linear-mcp-ops.md`, map lifecycle semantics to team statuses, and capture rationale/comments for each transition.

## Routing order (metadata-first)
1. Workpackage execution or continuation (`docs/workpackages/...`, `docs/review/workpackages_*`, or explicit workpackage execution directive).
2. Explicit Linear lifecycle or transition operation.
3. Implementation intent with missing must-have scope/acceptance constraints.
4. Spec-first iterative planning without explicit workpackage execution.
5. Planning fallback to clarification.

Conflict rule: if workpackage and Linear cues appear together, run workpackage routing first; keep Linear context checks read-only unless transition actions are explicitly requested.

Routing note: `trigger_phrases` are lexical boosters only and must not be treated as literal match gates.

If workpackage hints are present, follow `skills/planning/references/spec-driven-iterative-builder.md` and keep `docs/specs/*` and related work-package files synchronized.

## References
- `skills/planning/references/ask-questions-if-underspecified.md` - minimal clarifying questions workflow with fast trigger test
- `skills/planning/references/spec-driven-iterative-builder.md` - spec-first iterative delivery with work-package integration mode
- `skills/planning/references/linear-mcp-ops.md` - Linear MCP operations and brainstorming capture
