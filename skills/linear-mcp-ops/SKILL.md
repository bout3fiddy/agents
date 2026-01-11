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

## Updates and edits
- For updates/closing/assigning, fetch issue details before changing.
- After writes, read back the issue and confirm the new state.

## Output expectations
- Keep responses brief: what was added/updated and where (issue IDs/URLs and project).
