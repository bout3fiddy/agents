---
name: coding
description: Use for code implementation, bug fixes, refactors, code reviews, and technical guidance. Trigger when the user asks to write, fix, review, or refactor code.
---

# Coding

Use for implementation, bug fixes, refactors, code reviews, and technical guidance.

## Smell baseline (check before finalizing any code change)

Hard rules:
- No fallback-first implementations — hard cutovers by default.
- No compatibility shims or dual paths without explicit user approval + documented owner, removal date, tracking issue.
- No broad catch blocks that silently fall back to legacy behavior.
- No `or`/`||` chains over mixed old/new field names with silent defaults.

Self-review signals (check your own output before presenting):
- **Speculative Generality**: abstractions, params, or config for hypothetical future use?
- **Duplicate Code**: copy-paste >3 similar lines instead of extracting?
- **Long Method**: function >40 lines or blending multiple responsibilities?
- **Feature Envy**: method uses another object's data more than its own?
- **Dead Code**: unreachable branches, unused functions, permanently disabled flags?

When doing explicit smell reviews, load `skills/code-smell-detection/SKILL.md` for the full detection catalog.

## Workflow

1. Confirm scope, constraints, and acceptance criteria.
2. Read only necessary code paths.
3. Implement minimal, focused changes.
4. Self-review against smell baseline above. Fix violations before presenting.
5. Validate with targeted checks/tests.
6. Summarize: changes, validations, and remaining risks.

## Quality rules

- Preserve existing architecture unless the task explicitly asks for structural change.
- Add/update tests when behavior changes.
- Keep edits small, cohesive, and traceable to the request.
- Do not auto-refactor unless the user explicitly asks for code changes.
