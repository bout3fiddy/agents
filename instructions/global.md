# Global Instructions

## Skills
- Resolve skills by intent through the runtime routing artifact (`~/.agents/skills.router.min.json`) using JSON queries. Do not use hardcoded skill-path lists.
- If a request maps to multiple likely intents, treat skill lookup as multi-skill activation and open each matching `SKILL.md` before acting.
- If no clear match is found, ask one concise clarification question and retry routing.
- Infer intent first, then onboard skills:
  - File edits in repo code/docs/config -> `task_type` = `implementation` (coding workflow).
  - AGENTS/CLAUDE architecture or repo-structure cleanup -> `task_type` = `housekeeping`.
  - Plan/spec work, Linear workflows, or work-package lifecycle transitions -> `task_type` = `planning`.
  - Any `skills/` directory changes (`SKILL.md`, `references/`, skill metadata, routing files) -> `task_type` = `skill-creation`.
  - Work package execution/refinement follow-up -> `task_type` = `refactor`/`review`/`bugfix` as seen in package path and user intent.
- For selected skill(s), load their `SKILL.md` via artifact path and read only the references explicitly needed for the request.
- For `SKILL.md` writes in `skills/`, prefer `skill-creator` workflow; do not use `coding` as the primary skill for that operation.
- If the user asks for a plan/spec, infer `planning` and run that workflow first, then proceed.
- When execution is driven by a work package folder or continuation prompt, infer the intended workflow from `task_type` in the path and load corresponding skills through routing metadata.

## Routing artifact contract
- Primary runtime routing artifact: `~/.agents/skills.router.min.json`.
- Runtime source: `instructions/skills.router.min.json`, hard-generated from `skills/*` and `skills/*/references/*`.
- If the runtime artifact is missing or stale, run `./bin/sync.sh` before routing.
- Query by task intent:
  - `jq '.by_task_type["implementation"] // [] | .[]' ~/.agents/skills.router.min.json`
  - `jq '.by_workflow_trigger["linear_issue_context_detected"] // [] | .[]' ~/.agents/skills.router.min.json`
- Resolve skill metadata from IDs:
  - `jq '.skills[] | select(.id=="coding.core")' ~/.agents/skills.router.min.json`
  - Open matched `SKILL.md` paths directly: `jq '.skills[] | select(.id | contains("coding")) | .path' ~/.agents/skills.router.min.json`
- Use `jq` examples exactly as intent/trigger examples; merge results as needed and de-duplicate by highest-priority route when conflicts exist.

## Non-literal trigger interpretation
- Treat `trigger_phrases` as intent exemplars and lexical hints, not exact-match gates.
- Use prompt meaning, conversation context, and current workflow state together when selecting skills/references.
- Explicit user skill requests still take precedence when they conflict with inferred routing.

## Workflow-state activation
- Skill/reference activation is not prompt-only; workflow events can activate or add skills mid-task.
- Respect `activation_policy` and `workflow_triggers` from skill/reference metadata when deciding activation.
- If workflow-state activation conflicts with explicit user instructions, ask a clarifying question before switching.

## Router re-evaluation hooks
- Re-evaluate routing on: `operation_changed`, `about_to_edit_path`, `about_to_write_linear`, `workpackage_state_changed`, `blocked_or_failed`, `scope_shift_detected`.
- Re-evaluation actions are: `keep`, `add`, `switch`, `ask_clarify`.
- `keep`: current skill set still matches; continue.
- `add`: keep current skill(s) and load additional required skill/reference.
- `switch`: replace active skill when operation/state changed materially.
- `ask_clarify`: pause routing changes and ask one targeted question.

## Quality gates
- If `.pre-commit-config.yaml` exists and you made code changes (source, tests, or executable build/lint/tooling config), run: `uv run prek run --all-files` (runs repo-defined hooks like ruff/ruff-format; it may modify files, so re-run and re-stage until clean). Skip `prek` for docs/planning-only changes (for example `docs/specs/**`, prose docs, and AGENTS/CLAUDE instruction edits) unless explicitly requested.
- Run tests affected by your changes.

## Toolchain
- If `uv.lock` or `pyproject.toml` exists, use `uv` for Python.
- For JS/TS, use `bun` when possible.

## Spec-driven work
- For multi-step or exploratory work, maintain `docs/specs/<slug>.md`.

## Repo-specific context
- If a repo has `AGENTS.md` or `CLAUDE.md`, read it first. These files capture repo-specific conventions, toolchains, and guardrails that override generic assumptions.
- Be proactive and specific: when you discover durable structural repo knowledge (e.g., key locations, workflows, repo commands, tooling/layout conventions), add a concise bullet to the nearest-scope `AGENTS.md` even if the user did not ask.
- Keep `AGENTS.md` curated, not append-only: deduplicate, remove stale/conflicting notes, and collapse near-duplicate guidance when you touch related areas.
- Use progressive disclosure architecture for agent docs: root `AGENTS.md` should stay concise (critical guardrails, task routing, canonical commands) and link to deeper docs for detailed/volatile content.
- Prefer scoped context over global sprawl: add nested `AGENTS.md` files in major subtrees (for example `apps/frontend`, `infra`, `apps/agent`) when domain guidance is dense.
- For AGENTS architecture work (progressive disclosure, monolith cleanup, contradiction pruning), explicitly invoke the `housekeeping` skill and its references.
- If an existing `AGENTS.md` is a legacy monolith (for example very long, mixed-domain flat lists, or contradictory bullets), migrate it to the progressive-disclosure model while preserving behavior guidance.
- Legacy migration action: move deep or volatile details into `.agents/repo-context/*`, add/refresh nested `AGENTS.md` for domain-specific instructions, and rewrite root `AGENTS.md` as a concise router.
- For volatile operational facts, include freshness metadata when feasible (`owner`, `last_verified`, and/or date) so stale notes can be pruned safely.
- If repo context is missing, create/update `AGENTS.md` with short bullet points and links to deeper references.

## Command discipline
- Don't run shell commands for discussion-only requests unless needed to apply a change.
- Run safe, routine commands by default. Only ask the user when a command is destructive, touches secrets, or needs explicit approval.
- For routine diagnostics, run the command yourself; only ask the user when blocked by permissions or environment limits, and explain why.

## Code-smell and refactoring guardrails
- For any code-writing task (not only explicit smell reviews), run a quick design check for these high-risk smells before finalizing changes: Speculative Generality (premature generalization), legacy compatibility aliases/shims, and fallback-first behavior.
- Default to a single canonical implementation path and hard cutovers; do not add compatibility aliases, dual paths, or runtime fallback chains unless the user explicitly asks for that migration risk profile.
- If a compatibility/fallback exception is explicitly approved, record owner, removal date, tracking issue/link, and validation plan in the same change.
- If a required dependency or CLI is missing, fail fast with a clear setup/install error instead of silently cascading through alternate tools or runtimes.
- Open the resolved coding workflow `SKILL.md` and applicable resolved coding references (at minimum speculative generality and fallback-first checks) whenever this guardrail is in scope.
- For work-package-driven refactoring execution, load the coding workflow and its resolved `refactoring` references through routing.
- When users ask for smell/refactoring reviews, run a diagnostic first (no auto-refactor), classify findings with canonical smell labels, include severity + concrete evidence, and provide refactoring options.
- Open and apply the resolved coding workflow and corresponding resolved code-smell references for smell classification.
- Implement refactors only when the user explicitly asks for code changes.

## Linear task completion
- Treat Linear work as operation-based (`create`, `refine`, `transition`, `status/report`, `comment-only`) with lifecycle-aware state handling.
- For `refine`, follow investigation-first behavior and update issue descriptions with concrete implementation guidance (`what`, `where`, `why`, `how`, acceptance criteria, validation plan) unless blocked.
- For transitions, map semantic state to team-specific statuses, verify writes, and move to `Completed` only with production evidence or explicit user confirmation.
- If a required write cannot be completed, leave a blocker note with current state, required next state, and explicit owner.
- Resolve planning workflow + linear references through skill metadata and apply those before status updates.

## Planning & Linear triggers
- Planning work, specs, or anything that touches Linear tickets must resolve to planning workflow and follow its resolved planning/Linear reference set.
- Treat planning/Linear requests as PM operation handoffs: infer intent (`create`, `refine`, `transition`, `status/report`, `comment-only`) from request meaning and workflow context, not exact phrase matching.
- Intent examples include requests to scope/action a ticket, move lifecycle state, provide status, or capture notes; these are illustrative, not exhaustive phrase gates.
- For `refine`, prefer description updates over comments unless comments are explicitly requested or a blocker must be recorded.
- Resolve planning references through metadata and apply the selected linear workflow docs before status updates.
- When this trigger fires, explicitly record whether each issue was created, refined, transitioned, commented, or left unchanged, and include issue IDs in the response.
- For each refined issue, include a concise evidence trace in the response (for example: inspected modules/files and why they support the refinement) so refinement quality is auditable.

## Work package standard
- Work packages must be created in `docs/workpackages/<task_type>_<name>_<date>/`.
- The folder name must include a task type prefix (`<task_type>`), for example `refactor`, `review`, `bugfix`, `migration`, or `feature`.
- Each work package folder may contain multiple markdown docs; `overview.md` is required and remains the canonical rollup for all `WP-*` items (status, evidence pointer, next action).
- Keep a linked Linear issue refined and traceable (scope, acceptance criteria, validation plan, and work-package path); transition lifecycle state as execution starts/completes.
- Treat repeated execution requests as continuation signals from the first non-done `WP-*` unless release criteria are already met.
- Resolve spec-driven iterative and work-package execution references through routing metadata (planning plus coding refs) for execution format, templates, and procedure.

## PR review bot loop
- When user intent is iterative PR-review remediation (for example: review-loop, fix reviewer/bot feedback, keep iterating until clean), run the PR review + CI loop workflow.
- Treat these examples as intent hints, not literal phrase gates.
- Required outcomes: triage new findings, fix true positives with relevant tests, respond on each review thread (fix or rationale), keep CI green, and iterate until no actionable findings remain before staging release.
- Resolve the coding PR-review reference documents through routing metadata and follow that operational loop.

## Routing artifact query behavior
- Runtime routing uses artifact queries only; do not route by hardcoded path lists.
- Skill and reference lookup should combine task-type + workflow-trigger signals, then apply fallback/conflict resolution by priority and workflow context.
