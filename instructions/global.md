# Global Instructions

<routing-gate>
Before your first tool call that reads or modifies repo code, match the user's
intent to a skill and read its SKILL.md. Skills contain domain guardrails
(security patterns, smell detection, design systems) that prevent common mistakes.

| Intent | Skill | Read |
|--------|-------|------|
| code, implement, bugfix, refactor, code review, smell audit | `coding` | `skills/coding/SKILL.md` |
| design, UI (general) | `design` | `skills/design/SKILL.md` |
| UI critique, review, feedback, audit | `design-critique` | `skills/design-critique/SKILL.md` |
| UI/layout/styling, design direction | `design-guidelines` | `skills/design-guidelines/SKILL.md` |
| animation, storyboard, motion | `storyboard-animation` | `skills/storyboard-animation/SKILL.md` |
| DialKit, sliders, controls, tuning | `dialkit` | `skills/dialkit/SKILL.md` |
| AGENTS/CLAUDE architecture, housekeeping | `housekeeping` | `skills/housekeeping/SKILL.md` |
| Supabase, database, migrations, RLS | `supabase` | `skills/supabase/SKILL.md` |
| GCP, Cloud Run, infra ops | `gcp-operations` | `skills/gcp-operations/SKILL.md` |
| Railway, deployments, services, environments, build failures | `railway-operations` | `skills/railway-operations/SKILL.md` |
| Cloudflare Workers, R2, web analytics, observability | `cloudflare` | `skills/cloudflare/SKILL.md` |
| Build MCP server on Cloudflare | `building-mcp-server-on-cloudflare` | `skills/building-mcp-server-on-cloudflare/SKILL.md` |
| Web performance, Core Web Vitals, Lighthouse audit | `cloudflare-web-perf` | `skills/cloudflare-web-perf/SKILL.md` |
| Cloudflare Workers best practices, anti-patterns | `cloudflare-workers-best-practices` | `skills/cloudflare-workers-best-practices/SKILL.md` |
| AST structural code search, ast-grep rules | `ast-grep` | `skills/ast-grep/SKILL.md` |
| PR review, Linear tickets, work packages | `workflows` | `skills/workflows/SKILL.md` |

- Match by intent, not exact keywords. Load multiple skills if ambiguous.
- If no clear match, ask one clarifying question and retry.
</routing-gate>

## Cross-cutting rules

- Toolchain: `uv` for Python (if `uv.lock`/`pyproject.toml` exists), `bun` for JS/TS when repo supports it.
- Quality: if `.pre-commit-config.yaml` exists and you changed code, run `uv run prek run --all-files`.
- Commands: don't run shell for discussion-only requests. Run safe, routine commands by default; ask only when destructive or touching secrets.

## Repo-specific context

- If a repo has `AGENTS.md` or `CLAUDE.md`, read it first — repo conventions override generic assumptions.
- Keep `AGENTS.md` curated: deduplicate, remove stale/conflicting notes, use progressive disclosure (concise root + scoped nested files + deep docs).
- When you discover durable structural repo knowledge, add a concise bullet to the nearest-scope `AGENTS.md`.
