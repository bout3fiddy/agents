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

## Repo-specific context
- If a repo has `AGENTS.md` or `CLAUDE.md`, read it first.
- If repo context is missing or needs to be condensed, create/update `docs/agent-context.md` with short bullet points and reference it from the root file. Only append new knowledge.

## Command discipline
- Don't run shell commands for discussion-only requests unless needed to apply a change.
- Run safe, routine commands by default. Only ask the user when a command is destructive, touches secrets, or needs explicit approval.
- For routine diagnostics, run the command yourself; only ask the user when blocked by permissions or environment limits, and explain why.

## Skills index
- agent-observability - detect explicit corrections to assistant behavior (e.g., "don't do X", "always do Y") and log a report in `docs/observed-coding-agent-issues.md` after completing the current request. Do not trigger on general frustration, meta-policy discussion, or hypotheticals. refs: PR template + self-heal metadata
- agent-browser - browser automation tool (not a sub-agent). Use only for navigation/forms/screenshots/extraction. refs: none
- coding - core engineering rules with indexed references (frontend + platform included). refs: see `skills/coding/SKILL.md`
- planning - clarify scope, spec-first delivery, and Linear tracking. refs: clarifying questions, spec workflow, Linear ops
- seo - SEO strategy and execution, including programmatic SEO at scale and SEO audits/diagnostics. refs: skills/seo/references/programmatic-seo.md, skills/seo/references/seo-audit.md
- skill-creator - create/install skills workflow. refs: checklist + templates

## Browser Automation
- `agent-browser` is a command-line tool, not an agent.
- Use `agent-browser` for web automation (see agent-browser skill).

## Agent observability trigger guardrails
- Require an explicit corrective directive about assistant behavior (imperative + desired future behavior).
- Exclusions: policy discussions, general frustration without a directive, and hypotheticals.
- If ambiguous, skip logging unless the user explicitly asks to log.
- Defer logging until after completing the current user request; never interrupt mid-task.
- Only log when there is a clear, actionable fix or guardrail to implement; otherwise skip.
