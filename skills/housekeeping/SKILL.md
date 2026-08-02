---
name: housekeeping
description: Organize and modernize AGENTS.md and CLAUDE.md context systems. Use when the user works on structuring, migrating, or curating agent instruction files and repository context architecture.
---

# Instruction Housekeeping

Keep always-loaded context small, durable, and scoped to where it applies.

1. Classify each instruction as personal/global, repository-wide, path-specific,
   reusable workflow, deep documentation, or volatile operational detail.
2. Keep the root `AGENTS.md` to critical guardrails, canonical commands, and
   links. Put domain rules in the nearest nested instruction file and reusable
   procedures in skills.
3. Move discoverable inventories, implementation notes, examples, and volatile
   defaults into canonical documentation before removing them from instructions.
4. Deduplicate guidance and resolve contradictions against source code, tests,
   and current commands. Do not preserve stale behavior merely because it was
   documented.
5. Keep `AGENTS.md` and `CLAUDE.md` reference chains aligned when both exist.
6. Verify links, instruction discovery, skill metadata, and affected validation
   commands after restructuring.

For volatile runbooks, record an owner or source and `last_verified` date when
that materially improves maintenance.
