---
name: planning
description: "Planning workflows for clarifying underspecified work, spec-driven delivery, and Linear-backed tracking."
---

# Planning (Clarify + Spec + Track)

Use this skill when work is underspecified, needs a spec-first plan, or should be captured/tracked in Linear.

## Scope & routing
- Use for planning/spec/clarification requests or when the user explicitly asks for a plan.
- If the primary task is creating/updating a skill, do not use planning unless the user explicitly requests a plan-only response (no edits).
- When opening references, use full repo paths like `skills/planning/references/...` (not `references/...`). If a reference read fails, retry once with the full path.
- If a trigger matches, open the referenced file before responding (even if you only plan to ask questions).
- If a word/length limit is given, comply and keep it short.

## Reference triggers (open before responding)
- Underspecified implementation request -> `skills/planning/references/ask-questions-if-underspecified.md`
- Spec-first/iterative plan -> `skills/planning/references/spec-driven-iterative-builder.md`
- Linear tickets/ops/brainstorm capture -> `skills/planning/references/linear-mcp-ops.md`

## References
- `skills/planning/references/ask-questions-if-underspecified.md` - minimal clarifying questions workflow
- `skills/planning/references/spec-driven-iterative-builder.md` - spec-first iterative delivery
- `skills/planning/references/linear-mcp-ops.md` - Linear MCP operations and brainstorming capture
