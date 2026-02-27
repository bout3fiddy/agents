---

description: Recommended AGENTS/CLAUDE architecture using concise root routing, scoped files, and .agents/repo-context deep docs.
metadata:
  id: housekeeping.ref.agents-architecture
  version: "1"
  task_types:
    - housekeeping
    - agents-architecture
    - claude-architecture
  trigger_phrases:
    - AGENTS/CLAUDE architecture
    - agents architecture
    - CLAUDE.md
    - references
    - references agents-architecture
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers: []
  route_exclude: false

---


# AGENTS/CLAUDE Architecture

Use this structure as the default target for repository agent instructions.

Canonical ownership:
- `instructions/global.md` owns policy and precedence for instruction handling.
- This reference defines the AGENTS/CLAUDE architecture pattern for implementation decisions; keep CLAUDE.md files as a mirror of root AGENTS intent where present.

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
