# Global Instructions

## Skills
- If a task clearly matches a skill in global or local skills repository, read its `SKILL.md` and follow it.
- Only open the specific `references/` files you need.
- If no skill matches, continue without one.
- Always consult the Skills index (auto-generated) to identify relevant skills and triggers.
- If a trigger matches, open the referenced file immediately; if a skill matches without a trigger, open its `SKILL.md` and follow any references it points to.
- When creating/refactoring `AGENTS.md` or `CLAUDE.md` architecture (including progressive disclosure or legacy monolith cleanup), open `skills/housekeeping/SKILL.md` before editing.
- For any file edits outside `skills/`, open `skills/coding/SKILL.md` before editing.
- For edits under `skills/` or `SKILL.md`, **read `skills/skill-creator/SKILL.md` before responding** and do not open `coding`.
- When editing another skill’s `SKILL.md`, ask the user to paste the relevant section instead of reading the file directly.
- When the user asks for a plan/spec, open `skills/planning/SKILL.md` before drafting.

## Quality gates
- If `.pre-commit-config.yaml` exists and you made changes to files the hooks could touch (code/config/etc. in this repo), run: `uv run prek run --all-files` (runs repo-defined hooks like ruff/ruff-format; it may modify files, so re-run and re-stage until clean). If no relevant changes were made, skip running `prek`.
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
- If an existing `AGENTS.md` is a legacy monolith (for example very long, mixed-domain flat lists, or contradictory bullets), migrate it to the progressive-disclosure model while preserving behavior guidance.
- Legacy migration action: move deep or volatile details into `.agents/repo-context/*`, add/refresh nested `AGENTS.md` for domain-specific instructions, and rewrite root `AGENTS.md` as a concise router.
- For volatile operational facts, include freshness metadata when feasible (`owner`, `last_verified`, and/or date) so stale notes can be pruned safely.
- If repo context is missing, create/update `AGENTS.md` with short bullet points and links to deeper references.

## Command discipline
- Don't run shell commands for discussion-only requests unless needed to apply a change.
- Run safe, routine commands by default. Only ask the user when a command is destructive, touches secrets, or needs explicit approval.
- For routine diagnostics, run the command yourself; only ask the user when blocked by permissions or environment limits, and explain why.

## Linear task completion
- Treat Linear work as a lifecycle state machine, not a one-off update. Default semantic flow is `Unrefined -> Backlog -> In Progress -> In Review -> Completed`, then map those semantics to the team's actual Linear statuses before writing.
- If work starts from `Backlog`/refined queue, move the issue to `In Progress` before implementation begins. If follow-up work happens after review, move it back to `In Progress` before making changes.
- Move to `In Review` only when implementation is done and validation evidence is ready. Move to `Completed` only when the work is in production (or the user explicitly confirms production completion criteria).
- Before closing your turn, add a PM-style comment to the issue that includes: work summary and acceptance criteria covered, validation/tests run (or why skipped), remaining follow-ups/caveats, and next owner + target state.
- If you cannot transition the issue (permissions, missing sign-off, missing deployment), leave a blocker comment with the current state, required next state, and exact owner who must act.

## PM lifecycle guardrails
- Treat every planning or Linear-facing request as a PM handoff: read current status, decide the next lifecycle state, apply transition, verify the update, and comment.
- Always narrate lifecycle intent in Linear comments (why this state now, what proves exit criteria, and what must happen next).
- Use `skills/planning/references/linear-mcp-ops.md` for the operational checklist (state mapping, transition triggers, and comment templates).

## Planning & Linear triggers
- Planning work, specs, or anything that touches Linear tickets must use the planning skill and `skills/planning/references/linear-mcp-ops.md`.
- When this trigger fires, explicitly record whether each issue is being created, refined, transitioned, or commented, and include issue IDs in the response.

## PR review bot loop
- When asked to iteratively fix PR review feedback, run this loop for the specified PR.
- Step 1: Fetch latest review + issue comments.
- Step 2: For each new review/issue comment, classify whether it is a true positive.
- Step 3: Only for true positives, fix actionable items, run relevant tests, then commit and push.
- Step 4: Always respond to each GitHub comment in both cases: if true positive, reply with what was fixed; if false positive, reply with why no code change is needed.
- Step 5: Check GitHub CI for the PR head commit and ensure all required checks/actions are passing.
- Step 6: If any required CI check/action is failing, fix the issue, run relevant tests, commit/push, and respond on the PR with what changed.
- Step 7: Sleep for 12 minutes (`sleep 720`) to allow review bots to post new findings.
- Step 8: Fetch comments again and compare against the previous snapshot.
- Step 9: If there are no new actionable comments and all required CI checks/actions are passing, create a staging release and stop.
- Step 10: If there are new actionable comments or required CI checks/actions are not passing, repeat from Step 2.

## Refactor bot loop (focused)
- Primary objective: reduce LOC non-destructively by removing duplication, consolidating repeated logic, and simplifying structure without changing behavior.
- When asked for repo-wide refactoring, audit against these coding-skill rules only:
- `3) Input validation at boundaries`
- `4) No code injection`
- `9) Error handling`
- `10) Configuration and constants`
- `11) Architecture and design`
- `12) Frontend safety`
- `15) Type hints (Python)`
- `16) Documentation hygiene`
- If subagents are available, spin them up in parallel to scan for duplication by domain (services, APIs, UI/components, tests, config/utilities) and return concrete merge/extract candidates.
- If subagents are not available, run the same duplicate-code scan sequentially.
- Create and maintain a spec at `docs/specs/refactor-<slug>.md` using the spec-driven builder workflow before broad refactors.
- Step 1: Establish a baseline health score out of 10 with evidence by rule.
- Step 2: Build a ranked deduplication backlog (exact duplicates first, then near-duplicates, then structural simplifications).
- Step 3: Refactor highest-impact items with minimal safe changes (extract shared primitives, delete redundant paths, unify constants/interfaces).
- Step 4: Run affected tests/linters/quality gates.
- Step 5: Reassess the score and update the spec with completed work, risks, LOC delta, and next actions.
- Step 6: Repeat Steps 2-5 until the score is above `9.0`, no critical violations remain in the focused rules, and no high-confidence duplication candidates remain.

## Skills list (manual)
- coding - core engineering rules for implementation, SQL, docs/config edits, and technical guidance, with indexed references (frontend + platform included). refs: see `skills/coding/SKILL.md`
- database-migrations - safe planning and execution of schema/data migrations. refs: skills/database-migrations/references/migration-checklist.md
- housekeeping - repository housekeeping for AGENTS/CLAUDE architecture, progressive disclosure, and legacy monolith migration. refs: skills/housekeeping/references/agents-architecture.md, skills/housekeeping/references/migration-playbook.md
- planning - clarify scope, spec-first delivery, and Linear tracking. refs: clarifying questions, spec workflow, Linear ops
- seo - SEO strategy and execution, including programmatic SEO at scale and SEO audits/diagnostics. refs: skills/seo/references/programmatic-seo.md, skills/seo/references/seo-audit.md
- skill-creator - create/update/install skills (including planning/specs and edits to skills/*) workflow. refs: checklist + templates

## Skills index (auto-generated)
- Pipe-delimited index built from `skills/*/SKILL.md` + `skills/*/references/*.md` during sync.

<!-- AGENTS_SKILLS_INDEX_START -->
AUTO-GENERATED SKILLS INDEX. SOURCE: skills/*/SKILL.md + skills/*/references/*.md
skill|coding|Core engineering rules for implementation, refactors, bug fixes, SQL, docs/config edits, commands, and technical guidance, with indexed references for specialized workflows.|skills/coding/SKILL.md
skill|design|Frontend design curation skill for UI critique, motion storyboarding, and DialKit tuning. Use when the user asks for interface feedback, animation sequencing, or interactive design-control setup.|skills/design/SKILL.md
skill|housekeeping|Repository housekeeping workflows for AGENTS/CLAUDE architecture, progressive disclosure, and migration of legacy monolithic instruction files.|skills/housekeeping/SKILL.md
skill|planning|Planning workflows for clarifying underspecified work, spec-driven delivery, and Linear-backed tracking.|skills/planning/SKILL.md
skill|skill-creator|Create, update, or install skills (including planning/specs and edits to skills/*) using our repo workflow (uv + skills-ref validation, lean SKILL.md, references/ for detail, and sync via bin/sync.sh [--hard]).|skills/skill-creator/SKILL.md
trigger|coding|Auth/secrets/credentials|skills/coding/references/secrets-and-auth-guardrails.md
trigger|coding|Infra/platform/ops/deploy/secrets/storage|skills/coding/references/platform-engineering/index.md
trigger|coding|JS/TS runtime or toolchain|skills/coding/references/bun.md
trigger|coding|PR review/CI/GitHub|skills/coding/references/gh-pr-review-fix.md
trigger|coding|React/Next.js|skills/coding/references/react/index.md
trigger|coding|SolidJS|skills/coding/references/solidjs/index.md
trigger|coding|UI/layout/motion or component design|skills/coding/references/frontend-engineering/index.md
trigger|coding|Utility-class styling (Tailwind)|skills/coding/references/frontend-engineering/tailwindcss-full.md
trigger|design|Animation/storyboard/motion/transition/entrance/timing/stagger/spring|skills/design/references/storyboard-animation.md
trigger|design|DialKit/sliders/controls/tuning panel/live params|skills/design/references/dialkit.md
trigger|design|UI critique/review/feedback/audit/polish/refine/redesign|skills/design/references/design-critique.md
trigger|housekeeping|AGENTS/CLAUDE architecture, progressive disclosure, or context-memory organization|skills/housekeeping/references/agents-architecture.md
trigger|housekeeping|Legacy monolithic AGENTS cleanup, contradiction pruning, or migration planning|skills/housekeeping/references/migration-playbook.md
trigger|planning|Spec-first/iterative plan|skills/planning/references/spec-driven-iterative-builder.md
trigger|planning|Ticketing or Linear ops/brainstorm capture|skills/planning/references/linear-mcp-ops.md
trigger|planning|Underspecified implementation request|skills/planning/references/ask-questions-if-underspecified.md
trigger|skill-creator|Adding or modifying a Rules section|skills/skill-creator/references/templates/rules-template.md
trigger|skill-creator|Creating a skill or skeleton|skills/skill-creator/references/templates/skill-skeleton.md
trigger|skill-creator|Running or verifying the checklist|skills/skill-creator/references/checklist.md
ref|coding|skills/coding/references/bun.md|Bun - JavaScript/TypeScript Runtime & Toolkit (Reference)|Bun is the preferred JavaScript/TypeScript toolkit when the repo supports it. If a repo is locked to npm/yarn/pnpm, follow its established toolchain and lockfile.
ref|coding|skills/coding/references/frontend-engineering/components-and-motion.md|Frontend Components: Full Reference|component patterns and motion recipes
ref|coding|skills/coding/references/frontend-engineering/design-guidelines.md|Frontend Design Guidelines (Reference)|visual design guidance
ref|coding|skills/coding/references/frontend-engineering/index.md|Frontend Engineering (Reference)|Index of reference files for references/frontend-engineering.
ref|coding|skills/coding/references/frontend-engineering/tailwindcss-full.md|Tailwind CSS Full Reference|Tailwind CSS v4 reference
ref|coding|skills/coding/references/gh-pr-review-fix.md|GH PR Review + CI Fix Workflow (Reference)|Follow this workflow to find the latest PR, gather reviewer feedback + CI failures, organize them, and fix them one by one.
ref|coding|skills/coding/references/index.md|References Index|Index of reference files for references/references.
ref|coding|skills/coding/references/platform-engineering/gcp-operations.md|GCP Operations (Generic)|generic GCP/Cloud Run ops and discovery steps
ref|coding|skills/coding/references/platform-engineering/index.md|Platform Engineering (Reference)|Index of reference files for references/platform-engineering.
ref|coding|skills/coding/references/platform-engineering/supabase.md|Supabase CLI Reference|Supabase CLI, migrations, RLS, storage workflows
ref|coding|skills/coding/references/react/index.md|React/Next.js Best Practices (Reference)|Index of reference files for references/react.
ref|coding|skills/coding/references/react/react-best-practices.md|React Best Practices|full Vercel React/Next.js guide
ref|coding|skills/coding/references/react/rules/advanced-event-handler-refs.md|Store Event Handlers in Refs|stable subscriptions
ref|coding|skills/coding/references/react/rules/advanced-use-latest.md|useLatest for Stable Callback Refs|prevents effect re-runs
ref|coding|skills/coding/references/react/rules/async-api-routes.md|Prevent Waterfall Chains in API Routes|2-10× improvement
ref|coding|skills/coding/references/react/rules/async-defer-await.md|Defer Await Until Needed|avoids blocking unused code paths
ref|coding|skills/coding/references/react/rules/async-dependencies.md|Dependency-Based Parallelization|2-10× improvement
ref|coding|skills/coding/references/react/rules/async-parallel.md|Promise.all() for Independent Operations|2-10× improvement
ref|coding|skills/coding/references/react/rules/async-suspense-boundaries.md|Strategic Suspense Boundaries|faster initial paint
ref|coding|skills/coding/references/react/rules/bundle-barrel-imports.md|Avoid Barrel File Imports|200-800ms import cost, slow builds
ref|coding|skills/coding/references/react/rules/bundle-conditional.md|Conditional Module Loading|loads large data only when needed
ref|coding|skills/coding/references/react/rules/bundle-defer-third-party.md|Defer Non-Critical Third-Party Libraries|loads after hydration
ref|coding|skills/coding/references/react/rules/bundle-dynamic-imports.md|Dynamic Imports for Heavy Components|directly affects TTI and LCP
ref|coding|skills/coding/references/react/rules/bundle-preload.md|Preload Based on User Intent|reduces perceived latency
ref|coding|skills/coding/references/react/rules/client-event-listeners.md|Deduplicate Global Event Listeners|single listener for N components
ref|coding|skills/coding/references/react/rules/client-localstorage-schema.md|Version and Minimize localStorage Data|prevents schema conflicts, reduces storage size
ref|coding|skills/coding/references/react/rules/client-passive-event-listeners.md|Use Passive Event Listeners for Scrolling Performance|eliminates scroll delay caused by event listeners
ref|coding|skills/coding/references/react/rules/client-swr-dedup.md|Use SWR for Automatic Deduplication|automatic deduplication
ref|coding|skills/coding/references/react/rules/index.md|React Rules References|Index of reference files for references/rules.
ref|coding|skills/coding/references/react/rules/js-batch-dom-css.md|Batch DOM CSS Changes|reduces reflows/repaints
ref|coding|skills/coding/references/react/rules/js-cache-function-results.md|Cache Repeated Function Calls|avoid redundant computation
ref|coding|skills/coding/references/react/rules/js-cache-property-access.md|Cache Property Access in Loops|reduces lookups
ref|coding|skills/coding/references/react/rules/js-cache-storage.md|Cache Storage API Calls|reduces expensive I/O
ref|coding|skills/coding/references/react/rules/js-combine-iterations.md|Combine Multiple Array Iterations|reduces iterations
ref|coding|skills/coding/references/react/rules/js-early-exit.md|Early Return from Functions|avoids unnecessary computation
ref|coding|skills/coding/references/react/rules/js-hoist-regexp.md|Hoist RegExp Creation|avoids recreation
ref|coding|skills/coding/references/react/rules/js-index-maps.md|Build Index Maps for Repeated Lookups|1M ops to 2K ops
ref|coding|skills/coding/references/react/rules/js-length-check-first.md|Early Length Check for Array Comparisons|avoids expensive operations when lengths differ
ref|coding|skills/coding/references/react/rules/js-min-max-loop.md|Use Loop for Min/Max Instead of Sort|O(n) instead of O(n log n)
ref|coding|skills/coding/references/react/rules/js-set-map-lookups.md|Use Set/Map for O(1) Lookups|O(n) to O(1)
ref|coding|skills/coding/references/react/rules/js-tosorted-immutable.md|Use toSorted() Instead of sort() for Immutability|prevents mutation bugs in React state
ref|coding|skills/coding/references/react/rules/rendering-activity.md|Use Activity Component for Show/Hide|preserves state/DOM
ref|coding|skills/coding/references/react/rules/rendering-animate-svg-wrapper.md|Animate SVG Wrapper Instead of SVG Element|enables hardware acceleration
ref|coding|skills/coding/references/react/rules/rendering-conditional-render.md|Use Explicit Conditional Rendering|prevents rendering 0 or NaN
ref|coding|skills/coding/references/react/rules/rendering-content-visibility.md|CSS content-visibility for Long Lists|faster initial render
ref|coding|skills/coding/references/react/rules/rendering-hoist-jsx.md|Hoist Static JSX Elements|avoids re-creation
ref|coding|skills/coding/references/react/rules/rendering-hydration-no-flicker.md|Prevent Hydration Mismatch Without Flickering|avoids visual flicker and hydration errors
ref|coding|skills/coding/references/react/rules/rendering-svg-precision.md|Optimize SVG Precision|reduces file size
ref|coding|skills/coding/references/react/rules/rerender-defer-reads.md|Defer State Reads to Usage Point|avoids unnecessary subscriptions
ref|coding|skills/coding/references/react/rules/rerender-dependencies.md|Narrow Effect Dependencies|minimizes effect re-runs
ref|coding|skills/coding/references/react/rules/rerender-derived-state.md|Subscribe to Derived State|reduces re-render frequency
ref|coding|skills/coding/references/react/rules/rerender-functional-setstate.md|Use Functional setState Updates|prevents stale closures and unnecessary callback recreations
ref|coding|skills/coding/references/react/rules/rerender-lazy-state-init.md|Use Lazy State Initialization|wasted computation on every render
ref|coding|skills/coding/references/react/rules/rerender-memo.md|Extract to Memoized Components|enables early returns
ref|coding|skills/coding/references/react/rules/rerender-transitions.md|Use Transitions for Non-Urgent Updates|maintains UI responsiveness
ref|coding|skills/coding/references/react/rules/server-after-nonblocking.md|Use after() for Non-Blocking Operations|faster response times
ref|coding|skills/coding/references/react/rules/server-cache-lru.md|Cross-Request LRU Caching|caches across requests
ref|coding|skills/coding/references/react/rules/server-cache-react.md|Per-Request Deduplication with React.cache()|deduplicates within request
ref|coding|skills/coding/references/react/rules/server-parallel-fetching.md|Parallel Data Fetching with Component Composition|eliminates server-side waterfalls
ref|coding|skills/coding/references/react/rules/server-serialization.md|Minimize Serialization at RSC Boundaries|reduces data transfer size
ref|coding|skills/coding/references/react/web-interface-guidelines.md|Web Interface Guidelines (UI Review Reference)|UI review checklist source and workflow
ref|coding|skills/coding/references/secrets-and-auth-guardrails.md|Secrets and Auth Guardrails (Reference)|1) Confirm scope: setup, remediation, or incident response. 2) Warn about side effects: call out any command that may persist credentials locally. 3) If a tool config path is involved (e.g., `CLOUDSDK_CONFIG`), ensure...
ref|coding|skills/coding/references/solidjs/index.md|SolidJS Best Practices (Reference)|Index of reference files for references/solidjs.
ref|coding|skills/coding/references/solidjs/rules/_sections.md|Sections|This file defines all sections, their ordering, impact levels, and descriptions. The section ID (in parentheses) is the filename prefix used to group rules.
ref|coding|skills/coding/references/solidjs/rules/_template.md|Rule Title Here|Optional description of impact
ref|coding|skills/coding/references/solidjs/rules/advanced-avoid-destructuring-callbacks.md|Avoid Destructuring Callback Props When You Need the Latest Function|prevents stale callbacks
ref|coding|skills/coding/references/solidjs/rules/async-api-routes.md|Prevent Waterfall Chains in API Routes|avoids request waterfalls
ref|coding|skills/coding/references/solidjs/rules/async-dependencies.md|Dependency-Based Parallelization|2-10× improvement
ref|coding|skills/coding/references/solidjs/rules/async-parallel.md|Promise.all() for Independent Operations|2-10× improvement
ref|coding|skills/coding/references/solidjs/rules/async-suspense-boundaries.md|Strategic Suspense Boundaries|faster initial paint
ref|coding|skills/coding/references/solidjs/rules/bundle-barrel-imports.md|Avoid Barrel File Imports|200-800ms import cost, slow builds
ref|coding|skills/coding/references/solidjs/rules/bundle-conditional.md|Conditional Module Loading|loads large data only when needed
ref|coding|skills/coding/references/solidjs/rules/bundle-defer-third-party.md|Defer Non-Critical Third-Party Libraries|loads after hydration
ref|coding|skills/coding/references/solidjs/rules/bundle-dynamic-imports.md|Dynamic Imports for Heavy Components|directly affects TTI and LCP
ref|coding|skills/coding/references/solidjs/rules/bundle-preload.md|Preload Based on User Intent|reduces perceived latency
ref|coding|skills/coding/references/solidjs/rules/client-event-listeners.md|Deduplicate Global Event Listeners|single listener for N components
ref|coding|skills/coding/references/solidjs/rules/index.md|Solidjs Rules References|Index of reference files for references/rules.
ref|coding|skills/coding/references/solidjs/rules/rendering-activity.md|Use Activity Component for Show/Hide|preserves state/DOM
ref|coding|skills/coding/references/solidjs/rules/rendering-conditional-render.md|Use Explicit Conditional Rendering|prevents rendering 0 or NaN
ref|coding|skills/coding/references/solidjs/rules/rendering-content-visibility.md|CSS content-visibility for Long Lists|10× faster initial render
ref|coding|skills/coding/references/solidjs/rules/rendering-svg-precision.md|Optimize SVG Precision|reduces file size
ref|coding|skills/coding/references/solidjs/rules/rerender-defer-reads.md|Defer Reactive Reads to Usage Point|avoids unnecessary subscriptions
ref|coding|skills/coding/references/solidjs/rules/rerender-dependencies.md|Narrow Reactive Dependencies|minimizes recomputation
ref|coding|skills/coding/references/solidjs/rules/rerender-derived-state.md|Subscribe to Derived State|reduces reactive notifications
ref|coding|skills/coding/references/solidjs/rules/rerender-memo.md|Extract to Memoized Computations or Components|reduces reactive work
ref|coding|skills/coding/references/solidjs/rules/rerender-transitions.md|Use Transitions for Non-Urgent Updates|maintains UI responsiveness
ref|coding|skills/coding/references/solidjs/rules/server-cache-lru.md|Cross-Request LRU Caching|caches across requests
ref|coding|skills/coding/references/solidjs/rules/server-query-dedup.md|Use query() + createAsync() for request dedupe and shared caching|deduplicates and shares server fetches
ref|coding|skills/coding/references/solidjs/solid-performance-guidelines.md|SolidJS Performance Guidelines|complete guide with rule index
ref|coding|skills/coding/references/solidjs/solidjs-full.md|SolidJS Full Reference|full SolidJS development reference
ref|design|skills/design/references/design-critique.md|Design Critique|Systematic critique workflow for screenshots, components, and pages with prioritized opportunities.
ref|design|skills/design/references/dialkit.md|DialKit|DialKit setup checks, smart defaults, and config-generation patterns for live tuning panels.
ref|design|skills/design/references/index.md|References Index|Index of reference files for design skill modules.
ref|design|skills/design/references/storyboard-animation.md|Storyboard Animation|Human-readable, stage-driven animation structure with centralized timing/config constants.
ref|housekeeping|skills/housekeeping/references/agents-architecture.md|AGENTS Architecture|Recommended progressive-disclosure architecture for AGENTS/CLAUDE systems.
ref|housekeeping|skills/housekeeping/references/index.md|References Index|Index of reference files for AGENTS/CLAUDE housekeeping architecture and migration.
ref|housekeeping|skills/housekeeping/references/migration-playbook.md|Legacy Monolith Migration Playbook|Step-by-step process to migrate legacy monolithic AGENTS files safely.
ref|planning|skills/planning/references/ask-questions-if-underspecified.md|Ask Questions If Underspecified|Use when user requests implementation work (implement, add, create, build, refactor, fix) AND the request lacks clear acceptance criteria, scope, or constraints. Do NOT use during exploration, explanation, or continua...
ref|planning|skills/planning/references/index.md|References Index|Index of reference files for references/references.
ref|planning|skills/planning/references/linear-mcp-ops.md|Linear MCP Ops|Manage Linear via MCP (create/update/search issues, tickets, tasks, projects, labels, comments, cycles). Auto-capture brainstorm/ideation into Linear, auto-check Linear context when conversation implies status/backlog...
ref|planning|skills/planning/references/spec-driven-iterative-builder.md|Spec-Driven Iterative Builder|Spec-first, iterative delivery workflow. Use when asked to tackle future considerations, do research/architecture, try approaches, keep progress in docs/specs, or continue building without frequent check-ins.
ref|skill-creator|skills/skill-creator/references/checklist.md|Skill Creation Checklist|Skill Creation Checklist
ref|skill-creator|skills/skill-creator/references/index.md|References Index|Index of reference files for references/references.
ref|skill-creator|skills/skill-creator/references/templates/index.md|Templates References|Index of reference files for references/templates.
ref|skill-creator|skills/skill-creator/references/templates/rules-template.md|Rule Title Here|Optional description of impact
ref|skill-creator|skills/skill-creator/references/templates/skill-skeleton.md|<Skill Title>|<what it does + when to use it>
<!-- AGENTS_SKILLS_INDEX_END -->
