# Global Instructions

These instructions apply to all projects unless overridden by project-specific CLAUDE.md or AGENTS.md files.

## Skill-first workflow

- Skills are the primary source of guidance. Before doing any task, search for relevant skills and load only the ones that match.
- Prefer the global skill store in `~/.agents/skills`. If a project includes its own skills directory, check that too.
- Search by keyword: `rg -n "description:|name:" ~/.agents/skills/**/SKILL.md`
- If no skills match, proceed without loading any skill.
