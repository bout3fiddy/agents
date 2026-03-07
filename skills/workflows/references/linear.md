# Linear Task Lifecycle

Load this workflow when the task involves Linear tickets (create, refine, transition, status, or comment).

## Operation types

Infer intent from prompt meaning and workflow context, not exact phrases:
- **create**: New issue with scope, acceptance criteria, and validation plan.
- **refine**: Investigation-first — update issue description with concrete implementation guidance (what, where, why, how, acceptance criteria, validation plan). Prefer description updates over comments unless comments are explicitly requested or a blocker must be recorded.
- **transition**: Map semantic state to team-specific statuses, verify writes. Move to `Completed` only with production evidence or explicit user confirmation.
- **status/report**: Summarize current state without modifying the issue.
- **comment-only**: Add a note without changing description or status.

## Workflow

1. Identify the operation type from request meaning.
2. For `refine`, investigate code/modules first, then update the issue description with concrete guidance.
3. For transitions, verify the write landed and confirm the new state.
4. If a required write cannot be completed, leave a blocker note with current state, required next state, and explicit owner.

## Output requirements

- Record whether each issue was created, refined, transitioned, commented, or left unchanged.
- Include issue IDs in the response.
- For each refined issue, include a concise evidence trace (inspected modules/files and why they support the refinement).
