---

name: housekeeping
description: Repository housekeeping workflows for AGENTS/CLAUDE architecture, progressive disclosure, and migration of legacy monolithic instruction files.
metadata:
  id: housekeeping.core
  version: "1"
  task_types:
    - agents-architecture
    - migration
    - claude-architecture
    - repo-housekeeping
    - housekeeping
  trigger_phrases:
    - AGENTS.md
    - CLAUDE.md
    - progressive disclosure
    - legacy AGENTS migration
    - instruction cleanup
    - context-memory organization
    - housekeeping
  priority: 65
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - agents_architecture_requested
    - legacy_migration_requested
    - docs_housekeeping_requested

---



# Housekeeping (AGENTS/CLAUDE Architecture)

Use this skill when work is about organizing or modernizing `AGENTS.md`/`CLAUDE.md` context systems.

## Operating rules
- Keep root `AGENTS.md` concise: critical guardrails, task router, canonical commands, and links.
- Prefer scoped instruction files in dense areas (`apps/frontend`, `infra`, `apps/agent`, etc.).
- Move deep or volatile details into `.agents/repo-context/*`, not root `AGENTS.md`.
- Curate continuously: deduplicate, resolve contradictions, and remove stale guidance.
- Preserve behavior intent during migrations; change structure first, then tighten wording.

## Workflow
1) Assess current state (concise router vs mixed/legacy monolith).
2) Select target architecture from references.
3) Migrate content into scoped `AGENTS.md` files and deep docs.
4) Rewrite root `AGENTS.md` as a short router.
5) Add freshness metadata for volatile facts where feasible.
6) Verify links/routes and remove conflicting duplicate rules.
7) If work includes both AGENTS.md and CLAUDE.md, apply parity checks in the same pass.

## Canonical ownership
- `instructions/global.md`: trigger registration, precedence, escalation, and lifecycle policy.
- `skills/housekeeping/SKILL.md`: workflow sequence and reference selection for housekeeping execution.
- `skills/housekeeping/references/*`: deep guidance and operating patterns; AGENTS and CLAUDE are references.

## Reference triggers (open when clearly relevant)
- AGENTS/CLAUDE architecture, progressive disclosure, or context-memory organization -> `skills/housekeeping/references/agents-architecture.md`
- Legacy monolithic AGENTS cleanup, contradiction pruning, or migration planning -> `skills/housekeeping/references/migration-playbook.md`

## References
- `skills/housekeeping/references/index.md` - References index for this skill
- `skills/housekeeping/references/agents-architecture.md` - Target architecture, file tree, and root template
- `skills/housekeeping/references/migration-playbook.md` - Legacy-to-modern migration workflow and checklist
