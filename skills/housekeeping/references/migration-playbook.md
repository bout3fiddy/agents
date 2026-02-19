---
description: Workflow to migrate large legacy AGENTS files into concise progressive-disclosure architecture.
---
# Legacy Monolith Migration Playbook

Use this when an existing `AGENTS.md` is long, mixed-domain, or contradictory.

## Trigger signals

- Root `AGENTS.md` is very long (for example 250+ lines) and flat.
- Frontend/infra/agent details are mixed in one list.
- Duplicate or conflicting rules exist.
- Operational notes lack freshness markers.

## Migration workflow

1. Inventory sections and tag each item as `global`, `domain`, or `volatile`.
2. Move domain-heavy content to scoped files (for example `apps/frontend/AGENTS.md`, `infra/AGENTS.md`, `apps/agent/AGENTS.md`).
3. Move deep/volatile details to `.agents/repo-context/<domain>.md` (and `.agents/repo-context/volatile/*` if needed).
4. Rewrite root `AGENTS.md` as concise router + critical global guardrails.
5. Remove duplicate/conflicting bullets after migration.
6. Add freshness metadata to volatile notes when feasible.
7. Verify all links/paths and that behavior guidance is preserved.

## Before / after pattern

```text
Before:
  AGENTS.md (400+ lines mixed frontend+infra+agent details)

After:
  AGENTS.md (80-120 lines: router + critical global rules)
  apps/frontend/AGENTS.md
  apps/agent/AGENTS.md
  infra/AGENTS.md
  .agents/repo-context/{index,frontend,infra,backend}.md
```

## Post-migration checklist

- [ ] Root `AGENTS.md` is concise and task-routable.
- [ ] Scoped `AGENTS.md` files exist for dense domains.
- [ ] Deep details are linked, not duplicated.
- [ ] Contradictions and stale bullets removed.
- [ ] Volatile entries include `owner` and `last_verified` where feasible.
