---
name: linear-mcp-ops
description: Manage Linear via MCP (create/update/search issues, tickets, tasks, projects, labels, comments, cycles). Auto-capture brainstorm/ideation into Linear, auto-check Linear context when conversation implies status/backlog/roadmap/priority/ownership, and auto-route items to the best project (create a project if needed).
---

# Linear MCP Ops

## Operating rules
- Use MCP tools to read/write Linear; do not ask the user to run commands.
- If only one team exists, use it by default.
- When conversation implies Linear context (status, backlog, roadmap, ownership, “did we already do this?”), query Linear before answering.
- When user is brainstorming or ideating, capture actionable items as issues automatically.

## Brainstorm capture (auto)
1) Extract actionable items from the conversation (one issue per item).
2) Title: short imperative phrase. Body: context + rationale + source summary.
3) Apply label `Brainstorm` if it exists; otherwise create it.
4) Route to the best project (see “Project routing”).
5) Set status to `Backlog` or `Todo` (prefer `Backlog` for raw ideas).
6) Verify creation by fetching the issue and summarize IDs/URLs briefly.

## Project routing (auto)
- List existing projects.
- Choose the project whose name/summary best matches the item’s keywords or theme.
- If no good match, create a new project using the dominant theme:
  - Name: concise topic (3–6 words).
  - Summary: 1–2 sentences with goal + scope.
  - Status: `Backlog`.
- Add the issue to that project.

## Contextual checks (auto)
- If the user asks about status, backlog, roadmap, priority, ownership, or “what’s next,” run a Linear search and summarize results with IDs/links.
- If a task references a prior decision, search issues by keywords first.

## Lifecycle model (default semantics)
- Use this semantic lifecycle by default: `Unrefined -> Backlog -> In Progress -> In Review -> Completed`.
- Do not assume exact status names across teams. First fetch team statuses and map each semantic state to the closest available status.
- `Unrefined`: idea captured, but acceptance criteria/scope is still missing.
- `Backlog`: refined enough to prioritize, not actively being implemented.
- `In Progress`: active implementation/rework is happening now.
- `In Review`: implementation is complete and awaiting review/QA/sign-off.
- `Completed`: work is production-complete (or explicitly confirmed by user/org policy as complete).

## Transition protocol (required)
1) Read issue details first (state, assignee, project, labels, blockers, latest comments).
2) Decide the next lifecycle state from evidence, not guesswork.
3) Apply the status update.
4) Re-read the issue to verify the write.
5) Add a PM-style transition comment that records rationale and next owner.

## Transition triggers (required)
- `Unrefined -> Backlog`: acceptance criteria and scope are defined enough for prioritization.
- `Backlog -> In Progress`: implementation starts; set owner/assignee if missing.
- `In Progress -> In Review`: implementation done and validation evidence is available.
- `In Review -> In Progress`: review finds required changes or follow-up implementation begins.
- `In Review -> Completed`: approvals/sign-off done and work is in production.
- If a required transition cannot be executed (permissions, missing approval, missing deploy), keep current state and leave a blocker comment with explicit next owner.

## PM lifecycle alignment
- Treat every planning or Linear-facing request as a PM handoff: verify current lane, execute the next valid lifecycle transition, then comment.
- Always include lifecycle intent in the comment: why this state now, what exit criteria were met, and what must happen next.
- When production status is unknown, do not mark `Completed`; keep in review/release-ready state and state what confirmation is missing.

## Required transition comment fields
- `State change`: `<from> -> <to>` and reason.
- `Work summary`: what changed and which acceptance criteria were addressed.
- `Validation`: tests/checks run (or explicit skip reason).
- `Follow-ups`: risks, caveats, monitoring, or linked child tasks.
- `Owner + next step`: who acts next and what state should follow.

## Updates and edits
- For updates/closing/assigning, fetch issue details before changing.
- After writes, read back the issue and confirm the new state.

## Output expectations
- Keep responses brief: what was added/updated and where (issue IDs/URLs and project).
