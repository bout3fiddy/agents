---
name: code-smells
description: Detect and classify code smells using a canonical smell catalog, then recommend targeted refactoring options without automatically rewriting code.
---

# Code Smells (Detection + Guidance)

Use this skill when users ask to assess code for smells, refactoring opportunities, maintainability issues, or general code quality.

## Operating rules
- Diagnose first: identify and classify smells before proposing edits.
- Use canonical smell names from this skill's catalog exactly.
- Anchor findings to concrete evidence (file/function/line or behavior).
- Pair smell findings with this quality checklist when applicable:
- Input validation at boundaries
- No code injection
- Error handling
- Configuration and constants
- Architecture and design
- Frontend safety
- Type hints (Python)
- Documentation hygiene
- Do not refactor automatically; only propose changes unless implementation is explicitly requested.
- Prioritize findings by impact and risk.

## Workflow
1) Confirm the review scope (files, functions, modules, PR, or snippet).
2) Detect smells using the reference catalog.
3) Report findings with: smell name, evidence, impact, suggested refactoring(s), and risk/effort.
4) Include relevant quality-check names from the operating-rules checklist for context.
5) If no smells are found, state that explicitly and note any residual risks or test gaps.
6) Apply code changes only when the user explicitly asks to implement refactors.

## Reference triggers (open when clearly relevant)
- Code smell/refactoring opportunity/maintainability/quality review -> `skills/code-smells/references/smells/index.md`

## References
- `skills/code-smells/references/index.md` - References index for this skill
- `skills/code-smells/references/smells/index.md` - Smell catalog with one reference file per smell
