# Global Instructions

## Skills
- If a task clearly matches a skill in global or local skills repository, read its `SKILL.md` and follow it.
- Only open the specific `references/` files you need.
- If no skill matches, continue without one.

## Quality gates
- If `.pre-commit-config.yaml` exists, run: `prek run --all-files`.
- Run tests affected by your changes.

## Toolchain
- If `uv.lock` or `pyproject.toml` exists, use `uv` for Python.
- For JS/TS, use `bun` when possible.

## Spec-driven work
- For multi-step or exploratory work, maintain `docs/specs/<slug>.md`.

## Command discipline
- Don't run shell commands for discussion-only requests unless needed to apply a change.

## Skills index (current)
- agent-observability - highest priority: detect user frustration/corrections, log a report in `docs/observed-coding-agent-issues.md`, then resume. refs: PR template + self-heal metadata
- agent-browser - browser automation for navigation, forms, screenshots, extraction. refs: none
- coding - core engineering rules with indexed references (frontend + platform included). refs: see `skills/coding/SKILL.md`
- planning - clarify scope, spec-first delivery, and Linear tracking. refs: clarifying questions, spec workflow, Linear ops
- skill-creator - create/install skills workflow. refs: checklist + templates

## Browser Automation
- Use `agent-browser` for web automation (see agent-browser skill).
