---
name: spec-driven-iterative-builder
description: Spec-first, iterative delivery workflow. Use when asked to tackle future considerations, do research/architecture, try approaches, keep progress in docs/specs, or continue building without frequent check-ins.
---

# Spec-Driven Iterative Builder

## Operating rules
- Create or update a spec in `docs/specs/<slug>.md` for each consideration before implementation.
- Keep the spec as the source of truth for progress, decisions, experiments, and next steps.
- Work incrementally: design, implement, validate, document, then move to the next item.
- Do not pause for approvals or check-ins; proceed within safety bounds. If blocked, record in the spec and continue with a viable alternative.

## Spec template (minimum sections)
- Title / Scope
- Goals and Non-goals
- Assumptions and Constraints
- Research Summary (with sources if used)
- Architecture and Approach
- Implementation Plan (ordered steps)
- Experiments / Trials (what was tried and outcomes)
- Validation (lint/tests run and results)
- Open Questions / Risks
- Next Steps

## Workflow (repeat per consideration)
1) Identify the consideration and create or update its spec in `docs/specs/`.
2) Gather required context from the codebase; summarize relevant findings in the spec.
3) Research when needed; capture sources and key takeaways in the spec.
4) Propose architecture and plan in the spec; then implement incrementally.
5) Try approaches in code; record outcomes and tradeoffs in the spec.
6) Run linting/pre-commit and relevant tests; record results in the spec.
7) If a path fails, pivot: research alternatives, try again, and document.
8) Mark the consideration complete in the spec and move to the next one.

## When things don’t work
- Use web search to find fixes or alternative approaches.
- Update the spec with what failed, why, and the new plan.
- Keep going until the consideration is resolved or clearly blocked.

## Output expectations
- Provide a short completion note and the spec path after finishing each consideration.
