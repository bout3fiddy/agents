# Housekeeping

Use when work is about organizing or modernizing `AGENTS.md`/`CLAUDE.md` context systems.

## Key rules

- Root `AGENTS.md` stays concise: critical guardrails, task router, canonical commands, and links.
- Domain-heavy guidance lives in nearest scope (`apps/frontend/AGENTS.md`, `infra/AGENTS.md`, etc.).
- Deep or volatile details go in `.agents/repo-context/*`, not root `AGENTS.md`.
- Curate continuously: deduplicate, resolve contradictions, remove stale guidance.
- Preserve behavior intent during migrations; change structure first, then tighten wording.
- Keep `AGENTS.md` and `CLAUDE.md` aligned when both exist.

## Workflow

1. Assess current state (concise router vs mixed/legacy monolith).
2. Migrate content into scoped `AGENTS.md` files and deep docs.
3. Rewrite root `AGENTS.md` as a short router.
4. Add freshness metadata for volatile facts where feasible.
5. Verify links/routes and remove conflicting duplicate rules.

## Target file tree

```text
repo/
  AGENTS.md                     # concise router + critical guardrails only
  .agents/
    repo-context/
      index.md                  # map of deep guidance
      frontend.md               # detailed frontend runbooks
      infra.md                  # deploy/terraform/release details
      backend.md                # service/runtime/data details
      volatile/
        YYYY-MM-DD-<topic>.md   # time-bounded operational notes
  apps/
    frontend/
      AGENTS.md                 # path-scoped frontend instructions
    agent/
      AGENTS.md                 # path-scoped agent runtime instructions
  infra/
    AGENTS.md                   # path-scoped infra/deploy instructions
```

## Root AGENTS template

```text
# Repo Notes
- What this repo is and major boundaries.
- 5-10 critical guardrails only.
- Task router: where to look for frontend/infra/agent/backend work.
- Canonical commands (build/test/deploy).
- Links to `.agents/repo-context/index.md` and scoped AGENTS files.
```

## Design rules

- Root file stays short and high-signal.
- Domain-heavy guidance lives in nearest scope.
- Volatile operations notes live in `.agents/repo-context`, not root.
- Prefer links over repeated copy.
- Resolve contradictions immediately when touched.

## Freshness metadata (for volatile notes)

When feasible, add metadata so stale facts are easy to prune:

```yaml
owner: <team-or-person>
last_verified: YYYY-MM-DD
```
