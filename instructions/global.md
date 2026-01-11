# Global Instructions

These instructions apply to all projects unless overridden by project-specific CLAUDE.md or AGENTS.md files.

## Skill-first workflow

- Skills are the primary source of guidance. Before doing any task, search for relevant skills and load only the ones that match.
- Prefer the global skill store in `~/.agents/skills`. If a project includes its own skills directory, check that too.
- Search by keyword: `rg -n "description:|name:" ~/.agents/skills/**/SKILL.md`
- If no skills match, proceed without loading any skill.
- If a task involves secrets, auth, credentials, tokens, or API keys, load and follow the `secrets-and-auth-guardrails` skill.
- If a task mentions Linear, issues/tickets/tasks, projects, backlog, roadmap, or brainstorming/ideation capture, load and follow the `linear-mcp-ops` skill.

## Execution and Quality Gates

- Run shell commands yourself within safety bounds; only ask the user for help when blocked by permissions, missing access, or when a decision/opinion is required.
- For any code changes, run the project's pre-commit hooks if configured.
- For any code changes, run all tests affected by the changed files and ensure they pass before finishing.
- Never write credentials or auth artifacts inside the repo (including temp dirs like `.gcloud_tmp/`); use a safe path outside the repo such as `$HOME/.config/<tool>` or `/tmp/<tool>`.

## Spec-Driven Delivery

- For multi-step or exploratory work, create and maintain a spec in `docs/specs/<slug>.md` as the source of truth.
- Document research, architecture choices, experiments, validation results, and next steps in the spec.
- Work incrementally and continue until each consideration is complete or clearly blocked.
