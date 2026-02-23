# Refactoring Work Package - UI

## Execution Directive (Standard)
Use the standard directive and continue from the first non-done item.

## Metadata
- Scope: UI component cleanup
- Constraints: Non-destructive visual behavior
- Skill references to invoke:
  - skills/coding/SKILL.md
  - skills/coding/references/refactoring/workpackage-template.md
  - skills/coding/references/code-smells/smells/index.md

### WP-01 Extract card primitive [Status: In Progress 2026-02-22]
Issue
- Card markup duplicated across pricing and checkout.

Needs
- Shared component primitive with stable props.

How
- Extract and reuse a base card component.

Why this approach
- Improves maintainability and consistency.

Recommendation rationale
- coding rules: 11, 12, 16
- smell mitigation: duplicate-code

Desired outcome
- Shared rendering path and no visual regressions.

Non-destructive tests
- Snapshot tests for pricing + checkout cards
- Manual smoke on localhost
