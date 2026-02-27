---
name: coding
description: Core engineering skill for implementation, bug fixes, refactors, and technical reviews with mandatory smell guardrails and targeted domain reference routing.
metadata:
  id: coding.core
  version: "1"
  task_types:
    - coding
    - implementation
    - bugfix
    - refactor
    - code-review
    - technical-guidance
    - platform
    - solidjs
  trigger_phrases:
    - implement
    - fix bug
    - refactor
    - code review
    - code smell
    - quality review
    - solidjs
    - infrastructure
    - platform engineering
    - deploy
    - secrets
    - pull request
    - ci failure
  priority: 80
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - implementation_request_detected
    - bugfix_request_detected
    - refactor_request_detected
    - code_review_requested
    - platform_request_detected
  operation_contracts:
    implementation:
      required_steps:
        - load_smell_baseline
        - choose_targeted_smell_refs
        - choose_domain_refs
        - implement_minimal_change
        - validate_changed_behavior
      required_output_fields:
        - summary
        - files_changed
        - validations
        - risks_or_followups
      forbidden_actions:
        - fallback_first_compat_shims
        - unrelated_refactors
    smell_review:
      required_steps:
        - load_smell_catalog
        - classify_findings
        - provide_evidence
        - propose_refactors_without_editing
      required_output_fields:
        - smell_labels
        - severity
        - evidence
        - refactor_options
      forbidden_actions:
        - auto_refactor_without_request
    pr_review_fix_loop:
      required_steps:
        - load_pr_review_workflow
        - classify_comments
        - fix_true_positives
        - respond_to_each_comment
        - check_required_ci
      required_output_fields:
        - true_positive_decisions
        - fixes_applied
        - ci_status
        - unresolved_items
      forbidden_actions:
        - skip_comment_responses
---

# Coding (Implementation + Review)

Use this skill when the primary intent is implementation, bug fixing, refactoring, code-quality review, or technical guidance for repository code changes.

## Scope and routing
- Use this skill for code edits, code-quality reviews, PR feedback loops, and infra/platform implementation tasks.
- If the request is planning/spec/lifecycle management, hand off to `planning`.
- If the request is AGENTS architecture housekeeping, hand off to `housekeeping`.
- If the request is under `skills/` or edits `SKILL.md`, hand off to `skill-creator`.
- For frontend framework guidance, use SolidJS references only (`skills/coding/references/solidjs/...`).

## Mandatory smell baseline (always for code changes)
For implementation/bugfix/refactor/review operations, always open:
- `skills/coding/references/code-smells/index.md`

Then open only the smell files that match detected patterns (for example: `ai-code-smell`, `long-method`, `duplicate-code`, `shotgun-surgery`, `speculative-generality`).

## Core workflow
1. Confirm scope, constraints, and acceptance criteria.
2. Load mandatory smell baseline refs.
3. Load domain refs relevant to the task.
4. Read only necessary code paths.
5. Implement minimal focused changes.
6. Validate with targeted checks/tests.
7. Summarize changes, validations, and remaining risks.

## Domain reference triggers (open when clearly relevant)
- Code smell / maintainability / quality diagnostics:
  - `skills/coding/references/code-smells/index.md`
  - `skills/coding/references/code-smells/smells/index.md`
- Work-package refactoring execution:
  - `skills/coding/references/refactoring/index.md`
- SolidJS implementation/performance:
  - `skills/coding/references/solidjs/index.md`
  - `skills/coding/references/solidjs/rules/index.md`
- Infra / deploy / platform ops:
  - `skills/coding/references/platform-engineering/index.md`
- Auth / credentials / secret handling:
  - `skills/coding/references/secrets-and-auth-guardrails.md`
- PR review bot loop / CI failure remediation:
  - `skills/coding/references/gh-pr-review-fix.md`
- JS/TS runtime and toolchain:
  - `skills/coding/references/bun.md`

## Quality rules
- Prefer hard cutovers over fallback-first compatibility branches.
- Avoid over-defensive code that obscures normal control flow.
- Preserve existing architecture unless the task explicitly asks for structural change.
- Add/update tests when behavior changes.
- Keep edits small, cohesive, and traceable to the request.

## Output expectations
- Explain decisions and key trade-offs.
- List changed files.
- Report validations run (or why skipped).
- Call out unresolved risks and follow-up actions.
