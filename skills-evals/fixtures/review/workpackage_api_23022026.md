# Refactoring Work Package - API

## Execution Directive (Standard)
Use the standard directive and continue from the first non-done item.

## Metadata
- Scope: API boundary hardening and deduplication
- Constraints: Non-destructive rollout
- Skill references to invoke:
  - skills/coding/SKILL.md
  - skills/coding/references/refactoring/workpackage-template.md
  - skills/coding/references/code-smells/smells/index.md

### WP-01 Extract shared request validator [Status: Todo]
Issue
- Validation duplicated across handlers.

Needs
- Shared validator utility with per-route schema parameters.

How
- Extract boundary validator and route wrappers.

Why this approach
- Single point of validation logic; lower regression risk.

Recommendation rationale
- coding rules: 3, 9, 11
- smell mitigation: duplicate-code, shotgun-surgery

Desired outcome
- Validation is centralized and test coverage remains green.

Non-destructive tests
- API route tests for valid + invalid payloads
- Error-shape contract tests
