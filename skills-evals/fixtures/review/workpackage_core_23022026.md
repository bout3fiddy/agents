# Refactoring Work Package - Core

## Execution Directive (Standard)
Use the standard directive and continue from the first non-done item.

## Metadata
- Scope: Core service refactor
- Constraints: Non-destructive behavior changes only
- Skill references to invoke:
  - skills/coding/SKILL.md
  - skills/coding/references/refactoring/workpackage-execution-directive.md
  - skills/coding/references/code-smells/smells/index.md

### WP-01 Consolidate auth validation [Status: Todo]
Issue
- Auth validation logic is duplicated across handlers.

Needs
- Extract a shared primitive and keep behavior stable.

How
- Introduce one validator function and call it from existing handlers.

Why this approach
- Reduces duplicate logic and future patching risk.

Recommendation rationale
- coding rules: 3, 9, 11
- smell mitigation: duplicate-code, divergent-change

Desired outcome
- One validation path with equivalent behavior.

Non-destructive tests
- Existing auth unit tests
- Added regression test for null user and blank token

### WP-02 Normalize error payloads [Status: Done 2026-02-20]
Implementation status (2026-02-20)
- Error envelope helper adopted in auth and profile modules.
